/**
 * ChatHost connects the SessionRuntime to one or more webviews (the sidebar
 * view, optional chat editor panels and the settings editor tab), handles
 * messages from the UI, and does VS Code-side actions (open files, show
 * diffs, notifications, badges).
 */
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import type { AgentProbe, ExtensionToWebview, McpStatus, PromptAttachmentInput, UiSettings, WebviewToExtension } from "../shared/protocol";
import { DEFAULT_SETTINGS_SECTION, parseSettingsSection, type SettingsSection } from "../shared/settingsUi";
import type { SessionRuntime } from "./session/SessionRuntime";
import { DiffContentProvider } from "./DiffContentProvider";
import { MessageBatcher } from "./MessageBatcher";
import { fetchCursorUsage } from "./session/usage";
import { probeAgent, readExtensionSettings, resetExtensionSetting, updateExtensionSetting } from "./settings";
import { AGENT_PATH_KEY } from "./platform";
import { hostEnv } from "./hostEnv";
import { SetupController, type SetupStatus } from "./setup";

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/** What a webview shows: the chat (sidebar view or editor panel) or the settings editor tab. */
type WebviewKind = "chat" | "settings";

interface Attached {
  readonly webview: vscode.Webview;
  readonly kind: WebviewKind;
  readonly isVisible: () => boolean;
  readonly reveal: () => void;
  ready: boolean;
}

export const SETTINGS_PANEL_TYPE = "cursorAcp.settings";

/** Host → webview messages the settings tab has no use for (transcript traffic, composer events). */
const CHAT_ONLY = new Set<ExtensionToWebview["type"]>(["item.upsert", "item.append", "items.reset", "sessions", "composer.insert", "composer.attach", "composer.focus", "files.results"]);
function skips(kind: WebviewKind, type: ExtensionToWebview["type"]): boolean {
  return kind === "settings" && CHAT_ONLY.has(type);
}

export interface ChatHostServices {
  /** Forwarded servers and the CLI's own `mcp list` (see mcpStatus.ts). */
  readonly mcpStatus: () => Promise<McpStatus>;
  /** Cursor plugin servers on or off (see pluginSync.ts). */
  readonly setPluginServers: (ids: ReadonlyArray<string>, enabled: boolean) => Promise<void>;
  /** Runs the automatic plugin server sync now. */
  readonly syncPluginServers: () => Promise<void>;
  /** A plugin's skills on or off (see cursorPluginSkills.ts). */
  readonly setPluginSkills: (plugins: ReadonlyArray<string>, enabled: boolean) => Promise<void>;
  /** Links or unlinks plugin skills after the setting changed. */
  readonly syncPluginSkills: () => Promise<void>;
  /** The agent's user-level mcp.json. */
  readonly userMcpConfigPath: () => string;
  /** The workspace folder (MCP sign-ins are saved per folder). */
  readonly workspaceCwd: string | undefined;
}

/** Hidden-view notifications of one kind arriving within this window are shown as a single message. */
const NOTIFICATION_COALESCE_MS = 750;

type NotificationKind = "permission" | "question" | "turn";

interface PendingNotification {
  timer: ReturnType<typeof setTimeout>;
  first: string;
  count: number;
}

export class ChatHost implements vscode.Disposable {
  private readonly attached = new Set<Attached>();
  private readonly batcher = new MessageBatcher((messages) => this.broadcast(messages));
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingNotifications = new Map<NotificationKind, PendingNotification>();
  private draft = "";
  private view: vscode.WebviewView | undefined;
  /** Fires once, the first time a webview reports ready (used by the dev script hook). */
  onFirstReady: (() => void) | undefined;
  private firstReadyFired = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly runtime: SessionRuntime,
    private readonly diffs: DiffContentProvider,
    private readonly log: vscode.LogOutputChannel,
    private readonly services: ChatHostServices,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("cursorAcp")) {
          this.send({ type: "settings", settings: this.uiSettings() });
          this.send({ type: "extensionSettings", settings: readExtensionSettings() });
          if (event.affectsConfiguration(`cursorAcp.${AGENT_PATH_KEY}`) || event.affectsConfiguration("cursorAcp.environment")) {
            void this.probe();
          }
        }
      }),
    );
  }

  // --- runtime events -------------------------------------------------------------

  /** Called by the runtime for every UI message. */
  onRuntimeMessage(message: ExtensionToWebview): void {
    this.batcher.push(message);
    if (message.type === "session") {
      this.updateBadge(message.session.pendingPermissions);
      const title = panelTitle(message.session.title);
      for (const panel of this.panels) if (panel.title !== title) panel.title = title;
    } else if (message.type === "items.reset") {
      // The transcript was replaced (new / resumed session); its before/after texts are unreachable now.
      this.diffs.clearTexts();
    }
  }

  onPermissionRequested(title: string): void {
    this.notifyHidden("permission", title);
  }

  onQuestionAsked(title: string): void {
    this.notifyHidden("question", title);
  }

  onTurnFinished(stopReason: string): void {
    this.notifyHidden("turn", stopReason);
  }

  /**
   * Shows one OS-style notification per kind for events that arrive while no
   * chat view is visible. Several events of the same kind within a short
   * window (e.g. a burst of permission requests) become a single message.
   */
  private notifyHidden(kind: NotificationKind, detail: string): void {
    if (this.anyVisible() || !this.notifyWhenHidden()) return;
    const pending = this.pendingNotifications.get(kind);
    if (pending) {
      pending.count += 1;
      return;
    }
    const timer = setTimeout(() => {
      const entry = this.pendingNotifications.get(kind);
      this.pendingNotifications.delete(kind);
      if (!entry || this.anyVisible()) return;
      this.showHiddenNotification(kind, entry.first, entry.count);
    }, NOTIFICATION_COALESCE_MS);
    this.pendingNotifications.set(kind, { timer, first: detail, count: 1 });
  }

  private showHiddenNotification(kind: NotificationKind, first: string, count: number): void {
    const open = (choice: string | undefined, expected: string) => {
      if (choice === expected) this.reveal();
    };
    switch (kind) {
      case "permission": {
        const text = count > 1 ? `Cursor Agent needs permission (${count} requests).` : `Cursor Agent needs permission: ${first}`;
        void vscode.window.showWarningMessage(text, "Review").then((choice) => open(choice, "Review"));
        return;
      }
      case "question": {
        const text = count > 1 ? `Cursor Agent has ${count} questions.` : `Cursor Agent: ${first}`;
        void vscode.window.showInformationMessage(text, "Open").then((choice) => open(choice, "Open"));
        return;
      }
      case "turn": {
        const text = first === "end_turn" ? "Cursor Agent finished." : `Cursor Agent stopped (${first.replace(/_/g, " ")}).`;
        void vscode.window.showInformationMessage(text, "Open").then((choice) => open(choice, "Open"));
        return;
      }
    }
  }

  // --- views --------------------------------------------------------------------------

  attachView(view: vscode.WebviewView): void {
    this.view = view;
    const attached = this.attach(view.webview, "chat", () => view.visible, () => view.show?.(true));
    view.onDidDispose(() => {
      this.attached.delete(attached);
      if (this.view === view) this.view = undefined;
    });
    view.onDidChangeVisibility(() => {
      void vscode.commands.executeCommand("setContext", "cursorAcp.viewFocused", view.visible);
    });
  }

  private readonly panels = new Set<vscode.WebviewPanel>();

  attachPanel(panel: vscode.WebviewPanel): void {
    const attached = this.attach(panel.webview, "chat", () => panel.visible, () => panel.reveal());
    this.panels.add(panel);
    panel.title = panelTitle(this.runtime.state.title);
    panel.onDidDispose(() => {
      this.attached.delete(attached);
      this.panels.delete(panel);
    });
  }

  // --- settings editor tab ---------------------------------------------------------------

  private settingsPanel: { panel: vscode.WebviewPanel; attached: Attached } | undefined;

  /** Opens the settings editor tab (a singleton), or reveals it and switches to `section`. */
  openSettings(section?: unknown): void {
    const target = parseSettingsSection(section);
    const existing = this.settingsPanel;
    if (existing) {
      existing.panel.reveal(undefined, false);
      if (target) {
        const message: ExtensionToWebview = { type: "showSettings", section: target };
        // Not batched: the message is for this one webview. Before `ready` the initial section comes from the HTML.
        if (existing.attached.ready) void existing.panel.webview.postMessage(message);
        else existing.panel.webview.html = this.html(existing.panel.webview, "settings", target);
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel(SETTINGS_PANEL_TYPE, "Cursor Agent Settings", { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, { retainContextWhenHidden: true });
    this.attachSettingsPanel(panel, target);
  }

  /** Wires a settings panel (new, or restored by the serializer after a reload). */
  attachSettingsPanel(panel: vscode.WebviewPanel, section?: SettingsSection): void {
    if (this.settingsPanel && this.settingsPanel.panel !== panel) {
      // A second restored panel: keep one.
      panel.dispose();
      this.settingsPanel.panel.reveal();
      return;
    }
    panel.title = "Cursor Agent Settings";
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, "media", "cursor-light.svg"),
      dark: vscode.Uri.joinPath(this.context.extensionUri, "media", "cursor-dark.svg"),
    };
    const attached = this.attach(panel.webview, "settings", () => panel.visible, () => panel.reveal(), section);
    this.settingsPanel = { panel, attached };
    panel.onDidDispose(() => {
      this.attached.delete(attached);
      if (this.settingsPanel?.panel === panel) this.settingsPanel = undefined;
    });
  }

  // --- history pane (inside the sidebar chat) --------------------------------------------

  /** Set when the history pane was asked for before the sidebar chat was ready to receive it. */
  private historyPending = false;

  /** Opens the session history pane in the sidebar chat (the caller reveals the view). */
  showHistory(): void {
    const target = [...this.attached].find((a) => a.kind === "chat" && a.webview === this.view?.webview);
    if (target?.ready) void target.webview.postMessage({ type: "showHistory" } satisfies ExtensionToWebview);
    else this.historyPending = true;
  }

  private attach(webview: vscode.Webview, kind: WebviewKind, isVisible: () => boolean, reveal: () => void, section?: SettingsSection): Attached {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview"), vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webview.html = this.html(webview, kind, section);
    const attached: Attached = { webview, kind, isVisible, reveal, ready: false };
    this.attached.add(attached);
    webview.onDidReceiveMessage((message: WebviewToExtension) => {
      if (message.type === "ready") {
        attached.ready = true;
        this.batcher.drain();
        void webview.postMessage({
          type: "snapshot",
          session: this.runtime.state,
          // The settings tab needs the session (models, options) but not the transcript.
          items: kind === "chat" ? this.runtime.model.getItems() : [],
          settings: this.uiSettings(),
          draft: this.draft,
        } satisfies ExtensionToWebview);
        // One-off messages sent before this webview existed were not delivered; replay the essentials.
        void webview.postMessage({ type: "extensionSettings", settings: readExtensionSettings() } satisfies ExtensionToWebview);
        if (this.lastProbe) void webview.postMessage({ type: "agentProbe", probe: this.lastProbe } satisfies ExtensionToWebview);
        if (this.setupStatus.phase !== "idle") void webview.postMessage({ type: "setupStatus", status: this.setupStatus } satisfies ExtensionToWebview);
        else if (this.runtime.state.connection === "error") void this.probe();
        if (this.historyPending && kind === "chat" && webview === this.view?.webview) {
          this.historyPending = false;
          void webview.postMessage({ type: "showHistory" } satisfies ExtensionToWebview);
        }
        if (!this.firstReadyFired) {
          this.firstReadyFired = true;
          this.onFirstReady?.();
        }
        return;
      }
      void this.handleMessage(message);
    });
    return attached;
  }

  /** Whether any chat is on screen (the settings tab does not count: it shows no permission prompts). */
  private anyVisible(): boolean {
    for (const a of this.attached) if (a.kind === "chat" && a.isVisible()) return true;
    return false;
  }

  reveal(): void {
    const first = [...this.attached].find((a) => a.kind === "chat");
    if (first) first.reveal();
    else void vscode.commands.executeCommand("cursorAcp.focus");
  }

  focusComposer(): void {
    this.reveal();
    this.send({ type: "composer.focus" });
  }

  send(message: ExtensionToWebview): void {
    this.batcher.push(message);
  }

  private broadcast(messages: ReadonlyArray<ExtensionToWebview>): void {
    for (const a of this.attached) {
      if (!a.ready) continue;
      for (const message of messages) {
        if (skips(a.kind, message.type)) continue;
        void a.webview.postMessage(message);
      }
    }
  }

  private updateBadge(pending: number): void {
    if (!this.view) return;
    this.view.badge = pending > 0 ? { value: pending, tooltip: pending === 1 ? "1 permission request" : `${pending} permission requests` } : undefined;
  }

  private notifyWhenHidden(): boolean {
    return vscode.workspace.getConfiguration("cursorAcp").get<boolean>("notifyWhenHidden", true);
  }

  private uiSettings(): UiSettings {
    const config = vscode.workspace.getConfiguration("cursorAcp");
    return {
      sendWithCtrlEnter: config.get<boolean>("sendWithCtrlEnter", false),
      showThoughts: config.get<boolean>("showThoughts", true),
      hiddenModels: config.get<string[]>("hiddenModels", []),
    };
  }

  // --- messages from the UI -------------------------------------------------------------

  /** Handles a UI message exactly as if the webview had sent it. */
  async handleMessage(message: WebviewToExtension): Promise<void> {
    try {
      switch (message.type) {
        case "prompt":
          this.draft = "";
          await this.runtime.prompt(message.text, message.attachments, message.mode ?? "queue");
          return;
        case "queue.sendNow":
          await this.runtime.sendQueuedNow(message.index);
          return;
        case "queue.clear":
          this.runtime.takeQueued(message.index);
          return;
        case "queue.move":
          this.runtime.moveQueued(message.from, message.to);
          return;
        case "queue.edit": {
          const queued = this.runtime.takeQueued(message.index);
          if (!queued) return;
          for (const attachment of queued.attachments) this.send({ type: "composer.attach", attachment });
          this.send({ type: "composer.insert", text: queued.text });
          this.send({ type: "composer.focus" });
          return;
        }
        case "draft":
          this.draft = message.text;
          return;
        case "cancel":
          await this.runtime.cancel();
          return;
        case "permission.respond":
          this.runtime.respondToPermission(message.requestId, message.optionId, message.scope);
          return;
        case "approvals.set":
          this.runtime.setApprovalPolicy(message.policy);
          return;
        case "model.saveDefault": {
          const state = this.runtime.state;
          if (!state.models) return;
          const options: Record<string, string | boolean> = {};
          for (const o of state.modelOptions) options[o.id] = o.currentValue;
          await updateExtensionSetting("defaultModel", state.models.currentModelId);
          await updateExtensionSetting("defaultModelOptions", options);
          this.send({ type: "extensionSettings", settings: readExtensionSettings() });
          const name = state.models.availableModels.find((m) => m.modelId === state.models!.currentModelId)?.name ?? state.models.currentModelId;
          this.send({ type: "toast", level: "info", text: `New sessions will start with ${name}${Object.keys(options).length ? " and its current options" : ""}.` });
          return;
        }
        case "question.respond":
          this.runtime.respondToQuestion(message.requestId, message.answers);
          return;
        case "question.skip":
          this.runtime.skipQuestion(message.requestId);
          return;
        case "plan.respond":
          this.runtime.respondToPlan(message.requestId, message.accepted, message.reason);
          return;
        case "session.new":
          await this.runtime.newSession();
          return;
        case "session.load":
          await this.runtime.loadSession(message.sessionId);
          return;
        case "session.fork":
          await this.runtime.forkAfterTurn(message.userItemId);
          this.send({ type: "composer.focus" });
          return;
        case "session.list":
          await this.sendSessionList();
          return;
        case "session.rename": {
          let title = message.title;
          if (title === undefined) {
            const current = message.sessionId === this.runtime.state.sessionId ? this.runtime.state.title : undefined;
            title = await vscode.window.showInputBox({ prompt: "Session title", value: current ?? "", placeHolder: "Leave empty to use Cursor's title" });
            if (title === undefined) return; // cancelled
          }
          this.runtime.renameSession(message.sessionId, title);
          await this.sendSessionList();
          return;
        }
        case "session.hide":
          this.runtime.hideSession(message.sessionId);
          await this.sendSessionList();
          return;
        case "sessions.setHidden":
          this.runtime.setSessionsHidden(message.sessionIds, message.hidden);
          await this.sendSessionList();
          return;
        case "session.reconnect":
          await this.runtime.reconnect();
          // The MCP page may be waiting for the agent to load a changed mcp.json.
          if (this.hasSettingsView()) void this.refreshMcpStatus();
          return;
        case "mode.set":
          await this.runtime.setMode(message.modeId);
          return;
        case "model.set":
          await this.runtime.setModel(message.modelId);
          return;
        case "config.set":
          await this.runtime.setConfigOption(message.configId, message.value);
          return;
        case "openFile":
          await this.openFile(message.path, message.line);
          return;
        case "openDiff":
          await this.openDiff(message.itemId, message.path);
          return;
        case "copy":
          await vscode.env.clipboard.writeText(message.text);
          this.send({ type: "toast", level: "info", text: `Copied ${message.text.length > 48 ? "to clipboard" : message.text}` });
          return;
        case "openSettings":
          await vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${this.context.extension.id}`);
          return;
        case "settings.open":
          this.openSettings(message.section);
          return;
        case "mcp.status":
          await this.refreshMcpStatus();
          return;
        case "mcp.openConfig":
          await this.openProjectMcpConfig();
          return;
        case "mcp.openUserConfig": {
          const path = this.services.userMcpConfigPath();
          try {
            await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false });
          } catch {
            this.send({ type: "toast", level: "info", text: `${path} does not exist yet.` });
          }
          return;
        }
        case "mcp.plugins.set":
          try {
            await this.services.setPluginServers(message.ids, message.enabled);
          } finally {
            await this.refreshMcpStatus();
          }
          return;
        case "plugins.skills.set":
          try {
            await this.services.setPluginSkills(message.plugins, message.enabled);
          } catch (error) {
            this.log.warn(`Plugin skills: ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            await this.refreshMcpStatus();
          }
          return;
        case "mcp.plugins.login": {
          const settings = readExtensionSettings();
          const error = await this.setup.mcpLogin({
            configuredPath: settings[AGENT_PATH_KEY],
            args: settings.agentArgs,
            env: hostEnv(settings.environment),
            cwd: this.services.workspaceCwd,
            id: message.id,
            onClosed: () => void this.refreshMcpStatus(),
            log: (m) => this.log.info(m),
          });
          if (error) this.send({ type: "toast", level: "error", text: error });
          return;
        }
        case "openLogs":
          this.log.show(true);
          return;
        case "openExternal":
          if (/^https?:\/\//i.test(message.url)) await vscode.env.openExternal(vscode.Uri.parse(message.url));
          return;
        case "attachActiveFile":
          this.attachActiveFile();
          return;
        case "pickFiles":
          await this.pickFiles();
          return;
        case "attachUris":
          await this.attachUris(message.uris);
          return;
        case "usage.refresh":
          await this.refreshUsage();
          return;
        case "files.search":
          await this.searchFiles(message.query, message.requestId);
          return;
        case "settings.get":
          this.send({ type: "extensionSettings", settings: readExtensionSettings() });
          return;
        case "settings.update":
          await updateExtensionSetting(message.key, message.value);
          this.send({ type: "extensionSettings", settings: readExtensionSettings() });
          if (message.key === "mcpPluginServers") {
            // Switching to automatic applies it right away; the page shows the new state either way.
            if (message.value === "auto") await this.services.syncPluginServers().catch((error: unknown) => this.log.warn(`Plugin MCP sync failed: ${error instanceof Error ? error.message : String(error)}`));
            await this.refreshMcpStatus();
          }
          if (message.key === "pluginSkills") {
            await this.services.syncPluginSkills().catch((error: unknown) => this.log.warn(`Plugin skills: ${error instanceof Error ? error.message : String(error)}`));
            await this.refreshMcpStatus();
          }
          return;
        case "settings.reset":
          await resetExtensionSetting(message.key);
          this.send({ type: "extensionSettings", settings: readExtensionSettings() });
          return;
        case "settings.probe":
          await this.probe();
          return;
        case "setup.install":
          this.setup.install(this.setupOptions());
          return;
        case "setup.login":
          await this.setup.login(this.setupOptions());
          return;
        case "settings.browseAgent": {
          const picked = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFolders: false, openLabel: "Use as Cursor Agent executable", title: "Select the Cursor Agent CLI (or a wrapper script)" });
          const uri = picked?.[0];
          if (uri) {
            await updateExtensionSetting(AGENT_PATH_KEY, uri.fsPath);
            this.send({ type: "extensionSettings", settings: readExtensionSettings() });
            await this.probe();
          }
          return;
        }
        default:
          return;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.log.error(`UI action failed: ${text}`);
      this.send({ type: "toast", level: "error", text });
    }
  }

  private usageInFlight: Promise<void> | undefined;

  private fileIndex: { files: ReadonlyArray<{ path: string; name: string }>; builtAt: number } | undefined;

  /** Fuzzy-ish workspace file search for @-mentions in the composer. */
  private async searchFiles(query: string, requestId: number): Promise<void> {
    if (!this.fileIndex || Date.now() - this.fileIndex.builtAt > 30_000) {
      const uris = await vscode.workspace.findFiles("**/*", "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**}", 5000);
      const files = uris.map((uri) => {
        const path = vscode.workspace.asRelativePath(uri, false);
        return { path, name: basename(path) };
      });
      this.fileIndex = { files, builtAt: Date.now() };
    }
    const q = query.trim().toLowerCase();
    const scored = this.fileIndex.files
      .map((file) => {
        const name = file.name.toLowerCase();
        const path = file.path.toLowerCase();
        let score = 0;
        if (!q) score = 1;
        else if (name.startsWith(q)) score = 100 - name.length;
        else if (name.includes(q)) score = 60 - name.length / 10;
        else if (path.includes(q)) score = 30 - path.length / 50;
        else if (isSubsequence(q, path)) score = 10 - path.length / 100;
        return { file, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((entry) => entry.file);
    this.send({ type: "files.results", requestId, query, files: scored });
  }

  private lastProbe: AgentProbe | undefined;
  private readonly setup = new SetupController();
  private setupStatus: SetupStatus = { phase: "idle" };

  private setupOptions() {
    const settings = readExtensionSettings();
    return {
      configuredPath: settings[AGENT_PATH_KEY],
      configDir: settings.configDir,
      env: hostEnv(settings.environment),
      onStatus: (status: SetupStatus) => {
        this.setupStatus = status;
        this.send({ type: "setupStatus", status });
      },
      onReady: () => {
        void this.probe();
        void this.runtime.reconnect();
      },
      log: (message: string) => this.log.info(message),
    };
  }

  /** Resolves the configured executable and reads its version; results go to the settings panel. */
  async probe(): Promise<void> {
    const settings = readExtensionSettings();
    const configuredPath = settings[AGENT_PATH_KEY];
    this.send({ type: "agentProbe", probe: { state: "checking", configuredPath, checkedAt: Date.now() } });
    const env = hostEnv(settings.environment);
    const probe = await probeAgent(configuredPath, env);
    this.lastProbe = probe;
    this.log.info(`Agent probe: ${probe.state}${probe.resolvedPath ? ` (${probe.resolvedPath}${probe.version ? `, ${probe.version}` : ""})` : ""}${probe.error ? ` – ${probe.error}` : ""}`);
    this.send({ type: "agentProbe", probe });
  }

  private mcpInFlight: Promise<void> | undefined;

  private hasSettingsView(): boolean {
    for (const a of this.attached) if (a.kind === "settings") return true;
    return false;
  }

  /** Runs the MCP status check (reads mcp.json files, asks `agent mcp list`) and sends the result to the UI. */
  async refreshMcpStatus(): Promise<void> {
    if (this.mcpInFlight) return this.mcpInFlight;
    this.send({ type: "mcpStatus", status: undefined, loading: true });
    this.mcpInFlight = this.services
      .mcpStatus()
      .then(
        (status) => this.send({ type: "mcpStatus", status, loading: false }),
        (error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);
          this.log.error(`MCP status failed: ${text}`);
          this.send({ type: "mcpStatus", status: { checkedAt: Date.now(), forwarded: [], files: [], cli: { error: text } }, loading: false });
        },
      )
      .finally(() => {
        this.mcpInFlight = undefined;
      });
    return this.mcpInFlight;
  }

  /** Opens the workspace's `.cursor/mcp.json`, creating an empty one first when it does not exist. */
  private async openProjectMcpConfig(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.send({ type: "toast", level: "info", text: "Open a folder first." });
      return;
    }
    const dir = vscode.Uri.joinPath(folder.uri, ".cursor");
    const file = vscode.Uri.joinPath(dir, "mcp.json");
    try {
      await vscode.workspace.fs.stat(file);
    } catch {
      await vscode.workspace.fs.createDirectory(dir);
      await vscode.workspace.fs.writeFile(file, Buffer.from('{\n  "mcpServers": {}\n}\n', "utf8"));
      this.log.info(`Created ${file.fsPath}`);
    }
    await vscode.window.showTextDocument(file, { preview: false });
  }

  async refreshUsage(): Promise<void> {
    if (this.usageInFlight) return this.usageInFlight;
    this.send({ type: "usage", usage: undefined, loading: true });
    const config = vscode.workspace.getConfiguration("cursorAcp");
    const configDir = config.get<string>("configDir", "").trim();
    const agentPath = this.runtime.agentExecutable;
    const extraEnv = config.get<Record<string, string>>("environment", {});
    this.usageInFlight = fetchCursorUsage({
      ...(configDir ? { configDir } : {}),
      ...(agentPath ? { agentPath } : {}),
      env: hostEnv(extraEnv),
    })
      .then((usage) => this.send({ type: "usage", usage, loading: false }))
      .finally(() => {
        this.usageInFlight = undefined;
      });
    return this.usageInFlight;
  }

  async sendSessionList(): Promise<void> {
    this.send({ type: "sessions", sessions: [], loading: true });
    try {
      // Hidden sessions are included (flagged) for the history pane's "Show hidden"; the chat filters them out.
      const sessions = await this.runtime.listSessions({ includeHidden: true });
      this.send({ type: "sessions", sessions, loading: false });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      // When the agent itself cannot start, the setup card already explains it; keep the list quiet.
      const agentDown = this.runtime.state.connection === "error";
      this.send({ type: "sessions", sessions: [], loading: false, ...(agentDown ? {} : { error: text }) });
    }
  }

  // --- editor integration ---------------------------------------------------------------

  private resolveUri(path: string): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const isAbsolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
    if (isAbsolute) {
      // Keep the remote authority when running on a remote extension host.
      return folder ? folder.uri.with({ path }) : vscode.Uri.file(path);
    }
    return folder ? vscode.Uri.joinPath(folder.uri, path) : vscode.Uri.file(path);
  }

  private async openFile(path: string, line?: number): Promise<void> {
    const uri = this.resolveUri(path);
    const options: vscode.TextDocumentShowOptions = { preview: true, preserveFocus: false };
    if (line && line > 0) {
      const position = new vscode.Position(line - 1, 0);
      options.selection = new vscode.Range(position, position);
    }
    await vscode.window.showTextDocument(uri, options);
  }

  /** Opens the native diff editor for an edit; an empty `itemId` means the latest edit of `path`. */
  private async openDiff(itemId: string, path: string): Promise<void> {
    const items = this.runtime.model.getItems();
    let found: { oldText: string; newText: string } | undefined;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (item.type !== "tool") continue;
      if (itemId && item.id !== itemId) continue;
      const diff = item.diffs.find((d) => d.path === path);
      if (diff) {
        const texts = this.diffs.textsFor(item.id, path);
        if (texts) {
          found = texts;
          break;
        }
      }
    }
    if (!found) {
      await this.openFile(path);
      return;
    }
    const name = basename(path);
    const left = this.diffs.register(`${name} (before)`, found.oldText);
    const right = this.diffs.register(`${name} (after)`, found.newText);
    await vscode.commands.executeCommand("vscode.diff", left, right, `${name}: Cursor edit`, { preview: true });
  }

  private attachActiveFile(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file" && editor.document.uri.scheme !== "vscode-remote") {
      this.send({ type: "toast", level: "info", text: "No file is open in the editor." });
      return;
    }
    this.send({ type: "composer.attach", attachment: this.fileAttachment(editor.document.uri) });
  }

  attachSelection(editor: vscode.TextEditor): void {
    const selection = editor.selection;
    const document = editor.document;
    if (selection.isEmpty) {
      this.send({ type: "composer.attach", attachment: this.fileAttachment(document.uri) });
      return;
    }
    const path = vscode.workspace.asRelativePath(document.uri, false);
    const startLine = selection.start.line + 1;
    const endLine = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line : selection.end.line + 1;
    const attachment: PromptAttachmentInput = {
      kind: "selection",
      label: `${basename(path)}:${startLine}${endLine !== startLine ? `-${endLine}` : ""}`,
      path,
      startLine,
      endLine,
      text: document.getText(selection),
    };
    this.send({ type: "composer.attach", attachment });
  }

  private fileAttachment(uri: vscode.Uri): PromptAttachmentInput {
    const path = vscode.workspace.asRelativePath(uri, false);
    return { kind: "file", label: basename(path), path };
  }

  /** Dropped URIs (Explorer, editor tabs, OS): images are inlined, everything else attached by path. */
  private async attachUris(uris: ReadonlyArray<string>): Promise<void> {
    let skipped = 0;
    for (const raw of uris.slice(0, 50)) {
      let uri: vscode.Uri;
      try {
        uri = vscode.Uri.parse(raw, true);
      } catch {
        skipped++;
        continue;
      }
      if (uri.scheme !== "file" && uri.scheme !== "vscode-remote") {
        skipped++;
        continue;
      }
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.Directory) {
          skipped++;
          continue;
        }
        const ext = uri.path.toLowerCase().match(/\.(png|jpe?g|gif|webp|bmp)$/)?.[1];
        if (ext && stat.size <= 8 * 1024 * 1024) {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
          this.send({ type: "composer.attach", attachment: { kind: "image", label: basename(uri.path), data: Buffer.from(bytes).toString("base64"), mimeType } });
          continue;
        }
      } catch {
        skipped++;
        continue;
      }
      this.send({ type: "composer.attach", attachment: this.fileAttachment(uri) });
    }
    if (skipped > 0) this.send({ type: "toast", level: "info", text: `Skipped ${skipped} dropped item${skipped === 1 ? "" : "s"}: only files can be attached.` });
    this.send({ type: "composer.focus" });
  }

  private async pickFiles(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFolders: false, openLabel: "Add to chat" });
    for (const uri of uris ?? []) {
      this.send({ type: "composer.attach", attachment: this.fileAttachment(uri) });
    }
  }

  // --- html ---------------------------------------------------------------------------------

  private html(webview: vscode.Webview, kind: WebviewKind, section?: SettingsSection): string {
    const dist = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, "main.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, "main.css"));
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(dist, "codicon.css"));
    const nonce = randomBytes(16).toString("base64");
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: https:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codicons}">
<link rel="stylesheet" href="${style}">
<title>${kind === "settings" ? "Cursor Agent Settings" : "Cursor"}</title>
</head>
<body data-view="${kind}"${kind === "settings" ? ` data-section="${section ?? DEFAULT_SETTINGS_SECTION}" data-version="${escapeAttr(String(this.context.extension.packageJSON?.version ?? ""))}"` : ""}>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.setup.dispose();
    this.batcher.dispose();
    for (const pending of this.pendingNotifications.values()) clearTimeout(pending.timer);
    this.pendingNotifications.clear();
    for (const d of this.disposables) d.dispose();
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function panelTitle(sessionTitle: string | undefined): string {
  return sessionTitle ? `Cursor: ${sessionTitle}` : "Cursor";
}
