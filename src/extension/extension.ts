import * as vscode from "vscode";
import { ChatHost, SETTINGS_PANEL_TYPE } from "./ChatHost";
import { AGENT_PATH_KEY } from "./platform";
import { DEFAULT_SAFE_LIST } from "./session/approvals";
import { acpSessionsDirCandidates } from "./session/forkStore";
import type { ApprovalPolicy, McpStatus } from "../shared/protocol";
import { DIFF_SCHEME, DiffContentProvider } from "./DiffContentProvider";
import { SessionRuntime, type AgentLaunchConfig, type SessionMeta } from "./session/SessionRuntime";
import { ThreadModel } from "./session/ThreadModel";
import type { WebviewToExtension } from "../shared/protocol";
import { hostEnv, prepareHostEnv } from "./hostEnv";
import { loadMcpServers, type McpServerSpec } from "./session/mcpConfig";
import { collectMcpStatus, formatMcpStatus } from "./mcpStatus";
import { parseSettingsSection } from "../shared/settingsUi";
import { PluginMcpSync, type PluginMode } from "./pluginSync";
import { updateExtensionSetting } from "./settings";

const PANEL_TYPE = "cursorAcp.panel";

/**
 * The chat lives in the secondary (right-hand) sidebar, where the other AI
 * chat extensions sit, when VS Code supports secondary-sidebar view containers
 * (1.100+). Older versions get an activity-bar container instead.
 */
function supportsSecondarySidebar(): boolean {
  const [major = 0, minor = 0] = vscode.version.split(".").map((part) => Number.parseInt(part, 10));
  return major > 1 || (major === 1 && minor >= 100);
}
const VIEW_ID = supportsSecondarySidebar() ? "cursorAcp.chat" : "cursorAcp.chatLeft";
const ALL_VIEW_IDS = ["cursorAcp.chat", "cursorAcp.chatLeft"] as const;

let host: ChatHost | undefined;
let runtime: SessionRuntime | undefined;
let pluginSync: PluginMcpSync | undefined;

function launchConfig(): AgentLaunchConfig {
  const config = vscode.workspace.getConfiguration("cursorAcp");
  // Empty means auto-detect (see DEFAULT_AGENT_COMMANDS); anything else is used as-is.
  // Windows hosts read their own key so a Windows path never leaks into WSL/SSH windows.
  const command = config.get<string>(AGENT_PATH_KEY, "").trim();
  const args = config.get<string[]>("agentArgs", []).filter((a) => typeof a === "string");
  const env = hostEnv(config.get<Record<string, string>>("environment", {}));
  return { command, args, env, protocolLogging: config.get<boolean>("protocolLogging", false) };
}

/** The MCP servers to hand to the agent with each session; see mcpConfig.ts. */
async function mcpServers(cwd: string | undefined, log: { warn(m: string): void }): Promise<ReturnType<typeof loadMcpServers> extends Promise<infer R> ? R : never> {
  const config = vscode.workspace.getConfiguration("cursorAcp");
  const forwardProject = config.get<boolean>("mcpForwardProjectServers", true);
  const trusted = vscode.workspace.isTrusted;
  if (forwardProject && cwd && !trusted) log.warn("Workspace is not trusted; its .cursor/mcp.json servers are not forwarded to the agent.");
  const result = await loadMcpServers({
    ...(forwardProject && cwd && trusted ? { projectDir: cwd } : {}),
    // The user-level file is not forwarded: the CLI loads it itself, with the sign-ins it saved for those
    // servers. A forwarded copy would replace the CLI's own client and lose that sign-in.
    env: launchConfig().env,
  });
  for (const source of result.sources) if (source.error) log.warn(`MCP config ${source.path}: ${source.error}`);
  return result;
}

/** Why the workspace's `.cursor/mcp.json` is not forwarded, if it is not. */
function projectMcpSkipped(cwd: string | undefined): string | undefined {
  if (!cwd) return "no folder is open";
  if (!vscode.workspace.getConfiguration("cursorAcp").get<boolean>("mcpForwardProjectServers", true)) return "forwarding project servers is turned off";
  if (!vscode.workspace.isTrusted) return "the workspace is not trusted";
  return undefined;
}

/** Forwarded servers plus what `agent mcp list` reports, for the settings tab and the Show MCP Servers command. */
async function mcpStatus(cwd: string | undefined, log: { warn(m: string): void }): Promise<McpStatus> {
  const launch = launchConfig();
  const skipped = projectMcpSkipped(cwd);
  const sync = pluginSync;
  return collectMcpStatus({
    loadServers: () => mcpServers(cwd, log),
    launch,
    cwd: cwd ?? process.cwd(),
    ...(skipped ? { projectSkipped: skipped } : {}),
    ...(sync
      ? {
          plugins: () => {
            const settings = pluginSettings();
            return { mode: settings.mode, exclude: settings.exclude, config: sync.resolve(launch), reconnectNeeded: sync.reconnectNeeded, skills: settings.skills, skillsExclude: settings.skillsExclude, skillTarget: sync.skillTarget(launch) };
          },
        }
      : {}),
  });
}

function pluginSettings() {
  const config = vscode.workspace.getConfiguration("cursorAcp");
  const mode = config.get<string>("mcpPluginServers", "auto");
  return {
    mode: (mode === "manual" || mode === "off" ? mode : "auto") as PluginMode,
    exclude: config.get<string[]>("mcpPluginExclude", []).filter((id) => typeof id === "string"),
    userConfig: config.get<string>("mcpUserConfig", ""),
    environment: config.get<Record<string, string>>("environment", {}),
    skills: config.get<boolean>("pluginSkills", true),
    skillsExclude: config.get<string[]>("pluginSkillsExclude", []).filter((entry) => typeof entry === "string"),
  };
}

/** ACP wire form of a server spec (stdio keeps Cursor's optional cwd). */
function toAcpServer(spec: McpServerSpec): import("@agentclientprotocol/sdk").McpServer {
  if ("url" in spec) return { type: spec.type, name: spec.name, url: spec.url, headers: [...spec.headers] };
  const stdio = { name: spec.name, command: spec.command, args: [...spec.args], env: [...spec.env], ...(spec.cwd ? { cwd: spec.cwd } : {}) };
  return stdio as import("@agentclientprotocol/sdk").McpServer;
}

function workspaceInfo(): { cwd: string; name: string } | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || (folder.uri.scheme !== "file" && folder.uri.scheme !== "vscode-remote")) return undefined;
  return { cwd: folder.uri.fsPath, name: folder.name };
}

export function activate(context: vscode.ExtensionContext): void {
  void vscode.commands.executeCommand("setContext", "cursorAcp.noSecondarySidebar", !supportsSecondarySidebar());
  const log = vscode.window.createOutputChannel("Cursor Agent", { log: true });
  context.subscriptions.push(log);
  const diffs = new DiffContentProvider();
  context.subscriptions.push(diffs, vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffs));

  const workspace = workspaceInfo();
  const cwd = workspace?.cwd ?? process.cwd();
  const sync = new PluginMcpSync({
    settings: pluginSettings,
    setExclude: (ids) => updateExtensionSetting("mcpPluginExclude", [...ids]),
    setSkillsExclude: (entries) => updateExtensionSetting("pluginSkillsExclude", [...entries]),
    store: context.globalState,
    log: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
  });
  pluginSync = sync;
  const storage = {
    getLastSessionId: () => context.workspaceState.get<string>(`cursorAcp.lastSession:${cwd}`),
    setLastSessionId: (id: string | undefined) => void context.workspaceState.update(`cursorAcp.lastSession:${cwd}`, id),
    getSessionMeta: () => context.globalState.get<SessionMeta>("cursorAcp.sessionMeta", { titles: {}, hidden: [] }),
    setSessionMeta: (meta: SessionMeta) => void context.globalState.update("cursorAcp.sessionMeta", meta),
  };

  const runtimeLogger = {
    info: (m: string) => log.info(m),
    warn: (m: string) => log.warn(m),
    error: (m: string) => log.error(m),
    protocol: (direction: "in" | "out", line: string) => log.trace(`${direction === "in" ? "←" : "→"} ${line.length > 4000 ? line.slice(0, 4000) + "…" : line}`),
    stderr: (text: string) => {
      for (const line of text.split(/\r?\n/)) if (line.trim()) log.debug(`[agent stderr] ${line}`);
    },
  };

  // The login-shell PATH lookup is bounded (5 s); the agent and its MCP servers need it.
  const envReady = prepareHostEnv(log);
  runtime = new SessionRuntime({
    cwd,
    workspaceName: workspace?.name ?? "(no folder)",
    ...(vscode.env.remoteName ? { remoteName: vscode.env.remoteName } : {}),
    getLaunchConfig: launchConfig,
    getModelDefaults: () => {
      const config = vscode.workspace.getConfiguration("cursorAcp");
      const modelId = config.get<string>("defaultModel", "").trim();
      return { ...(modelId ? { modelId } : {}), options: config.get<Record<string, string | boolean>>("defaultModelOptions", {}) };
    },
    getApprovalConfig: () => {
      const config = vscode.workspace.getConfiguration("cursorAcp");
      return { policy: config.get<ApprovalPolicy>("approvalPolicy", "safe"), safeList: config.get<string[]>("safeList", [...DEFAULT_SAFE_LIST]) };
    },
    getMcpServers: async () => (await mcpServers(workspace?.cwd, log)).servers.map(toAcpServer),
    // Cursor plugin MCP servers go into the agent's own user-level mcp.json (see pluginSync.ts).
    launchHooks: {
      beforeSpawn: (launch) => sync.beforeSpawn(launch),
      afterInitialize: (launch, pid) => sync.afterInitialize(launch, pid),
    },
    // Plugin skills linked by the sync get a plugin label in the slash menu.
    describeCommand: (name) => sync.commandInfo(name),
    // Every launch (startup resume, history list, reconnect) waits for the PATH lookup inside the runtime,
    // so the startup resume below can be queued at once, ahead of anything a view asks for.
    beforeConnect: () => envReady,
    getSessionsDirs: () => {
      const launch = launchConfig();
      const configDir = vscode.workspace.getConfiguration("cursorAcp").get<string>("configDir", "");
      return acpSessionsDirCandidates(launch.env, [sync.agentCursorDir(launch).cursorDir, configDir]);
    },
    storage,
    log: runtimeLogger,
    events: {
      message: (message) => host?.onRuntimeMessage(message),
      permissionRequested: (title) => host?.onPermissionRequested(title),
      turnFinished: (reason) => host?.onTurnFinished(reason),
      questionAsked: (title) => host?.onQuestionAsked(title),
      // The UI shows a setup card with the probe result; no need to force the settings panel open.
      agentUnavailable: () => void host?.probe(),
    },
  });
  // Capture full before/after texts for the native diff editor.
  attachDiffCapture(runtime.model, diffs);

  host = new ChatHost(context, runtime, diffs, log, {
    mcpStatus: async () => {
      // `mcp list` and stdio commands need the login-shell PATH.
      await envReady;
      return mcpStatus(workspace?.cwd, log);
    },
    setPluginServers: async (ids, enabled) => {
      const outcome = await sync.setEnabled(ids, enabled, launchConfig());
      if (outcome.added.length) log.info(`Added Cursor plugin MCP servers: ${outcome.added.join(", ")}`);
      if (outcome.removed.length) log.info(`Removed Cursor plugin MCP servers: ${outcome.removed.join(", ")}`);
    },
    setPluginSkills: async (plugins, enabled) => {
      const outcome = await sync.setSkillsEnabled(plugins, enabled, launchConfig());
      if (outcome.error) throw new Error(outcome.error);
    },
    syncPluginSkills: async () => {
      const launch = launchConfig();
      const outcome = sync.syncSkills(sync.resolve(launch), sync.skillTarget(launch));
      if (outcome.changed) sync.reconnectNeeded = true;
      if (outcome.error) throw new Error(outcome.error);
    },
    syncPluginServers: async () => {
      const outcome = await sync.sync(sync.resolve(launchConfig()));
      if (outcome.error) throw new Error(outcome.error);
      if (outcome.changed) sync.reconnectNeeded = true;
    },
    userMcpConfigPath: () => sync.resolve(launchConfig()).path,
    workspaceCwd: workspace?.cwd,
  });
  context.subscriptions.push(host);

  let started = false;
  /**
   * Opens the startup session once: the last session when resuming is on. Synchronous on purpose:
   * the resume must be queued before whatever the caller does next (New Session, a prompt, the
   * history list), or it would run after it and replace it. The runtime waits for the PATH lookup.
   */
  const ensureStarted = () => {
    if (started || !runtime) return;
    started = true;
    if (!workspace) {
      runtime.model.addNotice("warning", "Open a folder to chat with the Cursor agent about it.", undefined, []);
      return;
    }
    const resume = vscode.workspace.getConfiguration("cursorAcp").get<boolean>("resumeLastSession", true);
    const last = resume ? storage.getLastSessionId() : undefined;
    void runtime.start(last);
  };

  for (const viewId of ALL_VIEW_IDS) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        viewId,
        {
          resolveWebviewView(view) {
            host?.attachView(view);
            ensureStarted();
          },
        },
        { webviewOptions: { retainContextWhenHidden: true } },
      ),
    );
  }

  const openPanel = () => {
    const panel = vscode.window.createWebviewPanel(PANEL_TYPE, "Cursor", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { retainContextWhenHidden: true });
    panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, "media", "cursor-light.svg"),
      dark: vscode.Uri.joinPath(context.extensionUri, "media", "cursor-dark.svg"),
    };
    host?.attachPanel(panel);
    ensureStarted();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorAcp.focus", () => {
      void vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      host?.focusComposer();
    }),
    vscode.commands.registerCommand("cursorAcp.cycleApprovals", () => {
      if (!runtime) return;
      const order = ["ask", "safe", "auto"] as const;
      const current = runtime.state.approvalPolicy ?? "safe";
      const next = order[(order.indexOf(current) + 1) % order.length]!;
      runtime.setApprovalPolicy(next);
      void vscode.window.setStatusBarMessage(`Cursor approvals: ${next === "safe" ? "Safe list" : next === "auto" ? "Auto" : "Ask"}`, 2000);
    }),
    vscode.commands.registerCommand("cursorAcp.copySessionId", async () => {
      const id = runtime?.state.sessionId;
      if (!id) {
        void vscode.window.showInformationMessage("No Cursor session is open in this window yet.");
        return;
      }
      await vscode.env.clipboard.writeText(id);
      void vscode.window.setStatusBarMessage(`Copied Cursor session id ${id}`, 3000);
    }),
    vscode.commands.registerCommand("cursorAcp.newSession", async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      ensureStarted();
      await runtime?.newSession();
    }),
    // The history pane in the sidebar chat: search, rename, archive/unarchive and resume.
    vscode.commands.registerCommand("cursorAcp.showHistory", async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      ensureStarted();
      host?.showHistory();
    }),
    // Keyboard-first alternative: a quick pick of this folder's sessions.
    vscode.commands.registerCommand("cursorAcp.quickHistory", async () => {
      ensureStarted();
      if (!runtime) return;
      try {
        const sessions = await runtime.listSessions();
        if (sessions.length === 0) {
          void vscode.window.showInformationMessage("No previous Cursor sessions for this folder.");
          return;
        }
        const picked = await vscode.window.showQuickPick(
          sessions.map((s) => ({
            label: s.title ?? s.sessionId.slice(0, 8),
            description: s.updatedAt ? new Date(s.updatedAt).toLocaleString() : undefined,
            detail: s.sessionId,
            sessionId: s.sessionId,
          })),
          { placeHolder: "Resume a Cursor session", matchOnDescription: true, matchOnDetail: true },
        );
        if (picked) {
          await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
          await runtime.loadSession(picked.sessionId);
        }
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not list sessions: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand("cursorAcp.openInEditor", openPanel),
    vscode.commands.registerCommand("cursorAcp.addSelectionToChat", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      ensureStarted();
      host?.attachSelection(editor);
      host?.focusComposer();
    }),
    vscode.commands.registerCommand("cursorAcp.addFileToChat", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) return;
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      ensureStarted();
      host?.send({ type: "composer.attach", attachment: { kind: "file", label: target.path.split("/").pop() ?? target.path, path: vscode.workspace.asRelativePath(target, false) } });
      host?.focusComposer();
    }),
    vscode.commands.registerCommand("cursorAcp.stop", () => runtime?.cancel()),
    vscode.commands.registerCommand("cursorAcp.reconnect", () => {
      ensureStarted();
      return runtime?.reconnect();
    }),
    vscode.commands.registerCommand("cursorAcp.showLogs", () => log.show(true)),
    vscode.commands.registerCommand("cursorAcp.showMcpServers", async () => {
      await envReady;
      const status = await mcpStatus(workspace?.cwd, log);
      // An open settings tab shows the same result.
      host?.send({ type: "mcpStatus", status, loading: false });
      log.info(formatMcpStatus(status).join("\n"));
      log.show(true);
    }),
    // Optional argument: a section id ("general", "agent", "approvals", "models", "mcp", "advanced").
    vscode.commands.registerCommand("cursorAcp.openSettings", (section?: unknown) => {
      // The Models section lists the session's models, so make sure the agent is up.
      ensureStarted();
      host?.openSettings(section);
    }),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(PANEL_TYPE, {
      deserializeWebviewPanel(panel) {
        host?.attachPanel(panel);
        ensureStarted();
        return Promise.resolve();
      },
    }),
    vscode.window.registerWebviewPanelSerializer(SETTINGS_PANEL_TYPE, {
      deserializeWebviewPanel(panel, state: unknown) {
        host?.attachSettingsPanel(panel, parseSettingsSection(state && typeof state === "object" ? (state as { settingsSection?: unknown }).settingsSection : undefined));
        ensureStarted();
        return Promise.resolve();
      },
    }),
  );

  // Development aids (only active when launched with these environment variables):
  //   CURSOR_ACP_AUTO_OPEN=1            opens the view immediately after activation
  //   CURSOR_ACP_DEV_SCRIPT=<file.json> replays [{ delayMs, message }] UI messages through the host
  if (process.env.CURSOR_ACP_AUTO_OPEN === "1") {
    void vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }
  const devScript = process.env.CURSOR_ACP_DEV_SCRIPT;
  if (devScript) {
    host.onFirstReady = () => {
      void (async () => {
        try {
          const steps = JSON.parse(await vscode.workspace.fs.readFile(vscode.Uri.file(devScript)).then((b) => Buffer.from(b).toString("utf8"))) as Array<{ delayMs?: number; message: WebviewToExtension }>;
          for (const step of steps) {
            await new Promise((r) => setTimeout(r, step.delayMs ?? 0));
            log.info(`[dev script] ${JSON.stringify(step.message).slice(0, 200)}`);
            await host?.handleMessage(step.message);
          }
        } catch (error) {
          log.error(`[dev script] ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
    };
  }

  log.info(`Cursor Agent activated (workspace: ${cwd}${vscode.env.remoteName ? `, remote: ${vscode.env.remoteName}` : ""}).`);
}

function attachDiffCapture(model: ThreadModel, diffs: DiffContentProvider): void {
  // SessionRuntime constructs the ThreadModel, so the capture hook is registered afterwards.
  model.setDiffListener((itemId, path, oldText, newText) => diffs.remember(itemId, path, oldText, newText));
}

/**
 * Stops the agent process (SIGTERM, then SIGKILL after a short grace period).
 * `context.subscriptions` (host, diff provider, views) are disposed by VS Code.
 */
export async function deactivate(): Promise<void> {
  const current = runtime;
  runtime = undefined;
  host = undefined;
  await current?.dispose();
}
