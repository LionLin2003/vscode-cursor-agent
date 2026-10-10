/**
 * Shared contract between the extension host (ACP client + session runtime)
 * and the webview UI. The extension host is the source of truth: it owns the
 * thread model and streams snapshots + deltas to any attached webview.
 */

import type { SettingsSection } from "./settingsUi";

// ---------------------------------------------------------------------------
// Thread items
// ---------------------------------------------------------------------------

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export interface DiffLine {
  readonly type: "context" | "add" | "del";
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: ReadonlyArray<DiffLine>;
}

export interface FileDiff {
  /** Absolute path as reported by the agent. */
  readonly path: string;
  /** Path relative to the workspace when possible (for display). */
  readonly displayPath: string;
  readonly hunks: ReadonlyArray<DiffHunk>;
  readonly additions: number;
  readonly deletions: number;
  readonly isNew: boolean;
  readonly isDeleted: boolean;
  /** Set when the diff was too large and hunks were cut. */
  readonly truncated?: boolean;
}

export interface ToolLocation {
  readonly path: string;
  readonly displayPath: string;
  readonly line?: number;
}

export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface PermissionState {
  readonly requestId: string;
  readonly options: ReadonlyArray<PermissionOption>;
  readonly state: "pending" | "resolved" | "cancelled";
  readonly selectedOptionId?: string;
  /** Human-readable reason from the agent, e.g. "Not in allowlist: echo". */
  readonly reason?: string;
  /** How a resolved request was decided: by the user, by the session allow-list, or by the policy. */
  readonly resolution?: "user" | "session" | "auto";
}

export type ApprovalPolicy = "ask" | "safe" | "auto";

export interface UserAttachment {
  readonly kind: "selection" | "file" | "image";
  /** Display label, e.g. `src/foo.ts:10-20` or `screenshot.png`. */
  readonly label: string;
  readonly path?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  /** For images: data URL for preview (kept small). */
  readonly previewDataUrl?: string;
}

export interface UserItem {
  readonly type: "user";
  readonly id: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<UserAttachment>;
  readonly createdAt: number;
  readonly replay?: boolean;
}

export interface AssistantItem {
  readonly type: "assistant";
  readonly id: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: number;
  readonly replay?: boolean;
}

export interface ThoughtItem {
  readonly type: "thought";
  readonly id: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: number;
  readonly endedAt?: number;
  readonly replay?: boolean;
}

export interface ToolItem {
  readonly type: "tool";
  readonly id: string;
  readonly toolCallId: string;
  readonly kind: ToolKind;
  readonly title: string;
  /** Hover text for the title when it is a friendly rewrite (MCP calls: the full server id and tool name). */
  readonly tooltip?: string;
  readonly status: ToolStatus;
  /** Shell command for execute tools. */
  readonly command?: string;
  /** Compact single-line description of the input (path, query, url…). */
  readonly subtitle?: string;
  /** Raw input, pretty-printed JSON, for the details view. */
  readonly inputText?: string;
  /** Accumulated textual output (stdout/stderr/content text). */
  readonly output: string;
  readonly exitCode?: number;
  readonly diffs: ReadonlyArray<FileDiff>;
  readonly locations: ReadonlyArray<ToolLocation>;
  /** File contents returned by read tools. */
  readonly fileContent?: string;
  readonly permission?: PermissionState;
  /** Cursor's `Mcp(server:tool)` pattern for MCP tool calls; what the safe list and "Allow for session" match on. */
  readonly mcpPattern?: string;
  readonly createdAt: number;
  readonly endedAt?: number;
  readonly replay?: boolean;
}

export interface PlanEntry {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed" | "cancelled";
  readonly priority?: "high" | "medium" | "low";
}

/** ACP `plan` session update (agent's live task list). */
export interface PlanItem {
  readonly type: "plan";
  readonly id: string;
  readonly entries: ReadonlyArray<PlanEntry>;
  readonly createdAt: number;
  readonly replay?: boolean;
}

export interface TodoEntry {
  readonly id: string;
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed" | "cancelled";
}

/** Cursor `cursor/update_todos` state. */
export interface TodosItem {
  readonly type: "todos";
  readonly id: string;
  readonly todos: ReadonlyArray<TodoEntry>;
  readonly createdAt: number;
  readonly replay?: boolean;
}

export interface QuestionOption {
  readonly id: string;
  readonly label: string;
}

export interface Question {
  readonly id: string;
  readonly prompt: string;
  readonly options: ReadonlyArray<QuestionOption>;
  readonly allowMultiple: boolean;
}

export interface QuestionAnswer {
  readonly questionId: string;
  readonly selectedOptionIds: ReadonlyArray<string>;
  /** Free-form text typed by the user when no option fits. */
  readonly text?: string;
}

/** Cursor `cursor/ask_question` request. */
export interface QuestionItem {
  readonly type: "question";
  readonly id: string;
  readonly requestId: string;
  readonly title?: string;
  readonly questions: ReadonlyArray<Question>;
  readonly state: "pending" | "answered" | "skipped" | "cancelled";
  readonly answers?: ReadonlyArray<QuestionAnswer>;
  readonly createdAt: number;
  readonly replay?: boolean;
}

/** Cursor `cursor/create_plan` request. */
export interface PlanProposalItem {
  readonly type: "plan_proposal";
  readonly id: string;
  readonly requestId: string;
  readonly name?: string;
  readonly overview?: string;
  readonly plan: string;
  readonly todos: ReadonlyArray<TodoEntry>;
  readonly state: "pending" | "accepted" | "rejected" | "cancelled";
  readonly createdAt: number;
  readonly replay?: boolean;
}

export type NoticeAction = "reconnect" | "newSession" | "openSettings" | "openLogs" | "retry";

export interface NoticeItem {
  readonly type: "notice";
  readonly id: string;
  readonly level: "info" | "warning" | "error";
  readonly text: string;
  readonly detail?: string;
  readonly actions: ReadonlyArray<NoticeAction>;
  readonly createdAt: number;
  readonly replay?: boolean;
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled"
  | "error"
  | string;

export interface TurnEndItem {
  readonly type: "turn_end";
  readonly id: string;
  readonly stopReason: StopReason;
  readonly durationMs: number;
  readonly createdAt: number;
  readonly replay?: boolean;
}

export interface DividerItem {
  readonly type: "divider";
  readonly id: string;
  readonly text: string;
  readonly createdAt: number;
  readonly replay?: boolean;
}

export type ThreadItem =
  | UserItem
  | AssistantItem
  | ThoughtItem
  | ToolItem
  | PlanItem
  | TodosItem
  | QuestionItem
  | PlanProposalItem
  | NoticeItem
  | TurnEndItem
  | DividerItem;

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

export type ConnectionState =
  | "idle" // no agent process
  | "starting" // spawning / initialize / authenticate / session setup
  | "loading" // session/load replaying history
  | "ready" // session open, no turn running
  | "running" // prompt in flight
  | "cancelling"
  | "disconnected" // process exited unexpectedly
  | "error"; // failed to start

export interface SessionMode {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface SessionModel {
  readonly modelId: string;
  readonly name: string;
  readonly description?: string;
}

export interface ConfigSelectOption {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
}

export interface ConfigOption {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly category?: string;
  readonly type: "select" | "boolean" | "string" | string;
  readonly currentValue: string | boolean;
  readonly options: ReadonlyArray<ConfigSelectOption>;
}

export interface AvailableCommand {
  readonly name: string;
  readonly description: string;
  readonly hint?: string;
  /** The Cursor plugin it comes from, when the extension linked it (see cursorPluginSkills.ts). */
  readonly plugin?: string;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly title?: string;
  readonly cwd?: string;
  readonly updatedAt?: string;
  /** Hidden from the history by the user (only listed for the history pane's "Show hidden"). */
  readonly hidden?: boolean;
  /** The model this session last used here, when the extension remembers one. */
  readonly modelId?: string;
}

export interface SessionState {
  readonly connection: ConnectionState;
  readonly sessionId?: string;
  readonly title?: string;
  readonly cwd: string;
  readonly workspaceName: string;
  readonly remoteName?: string;
  readonly agentCommand: string;
  readonly agentVersion?: string;
  readonly modes?: { readonly currentModeId: string; readonly availableModes: ReadonlyArray<SessionMode> };
  readonly models?: { readonly currentModelId: string; readonly availableModels: ReadonlyArray<SessionModel> };
  /** Config options for the *current* model (effort, context, fast…), excluding mode/model selectors. */
  readonly modelOptions: ReadonlyArray<ConfigOption>;
  readonly availableCommands: ReadonlyArray<AvailableCommand>;
  readonly pendingPermissions: number;
  readonly lastError?: string;
  /** The CLI is installed but not logged in on this machine. */
  readonly authRequired?: boolean;
  /** Login URL Cursor handed back when it could not open a browser itself. */
  readonly loginUrl?: string;
  /** Files touched by edit tools in this session, for the "changes" summary. */
  readonly changedFiles: ReadonlyArray<{ readonly path: string; readonly displayPath: string; readonly additions: number; readonly deletions: number }>;
  readonly turnStartedAt?: number;
  /** Messages waiting to be sent, in order, when the current turn ends. */
  readonly queued?: ReadonlyArray<{ readonly text: string; readonly attachmentCount: number }>;
  /** Client-side approval policy for this session. */
  readonly approvalPolicy?: ApprovalPolicy;
  /** Commands / tools allowed for the rest of this session via "Allow for session". */
  readonly sessionAllowed?: ReadonlyArray<string>;
}

export interface UsageWindow {
  readonly id: string;
  readonly label: string;
  readonly usedPercent: number;
}

export interface UsageSummary {
  readonly checkedAt: number;
  readonly windows: ReadonlyArray<UsageWindow>;
  readonly resetsAt?: string;
  readonly message?: string;
  readonly autoMessage?: string;
  readonly namedMessage?: string;
  readonly spendUsd?: number;
  readonly limitUsd?: number;
  readonly bonusUsd?: number;
  /** Start of the current billing cycle (ISO). */
  readonly cycleStartsAt?: string;
  /** Portion of the spend covered by the plan's included allowance. */
  readonly includedSpendUsd?: number;
  /** Whether Cursor reports bonus (provider-funded) usage still available. */
  readonly bonusRemaining?: boolean;
  /** Team/pooled spend-limit usage, when the account is on a team plan. */
  readonly teamSpend?: {
    readonly totalUsd?: number;
    readonly individualUsd?: number;
    readonly pooledUsd?: number;
    readonly limitType?: string;
  };
  /** Cursor's first-party model ids (the "Cursor usage" pool). */
  readonly autoModels?: ReadonlyArray<string>;
  /** The logged-in CLI account, when Cursor reports it. */
  readonly account?: {
    readonly email?: string;
    readonly team?: string;
    readonly teamRole?: string;
  };
  readonly error?: string;
}

export interface UiSettings {
  readonly sendWithCtrlEnter: boolean;
  readonly showThoughts: boolean;
  /** Model ids hidden from the picker. */
  readonly hiddenModels: ReadonlyArray<string>;
}

/** Full extension configuration, mirrored from VS Code settings for the in-app settings panel. */
export interface ExtensionSettings {
  /** Agent path used by macOS, Linux, WSL and Remote SSH hosts. */
  readonly agentPath: string;
  /** Agent path used only when the extension host itself runs on Windows. */
  readonly agentPathWindows: string;
  /** Which of the two path keys this extension host actually reads. */
  readonly agentPathKey: "agentPath" | "agentPathWindows";
  readonly agentArgs: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
  readonly configDir: string;
  /** Forward the workspace's `.cursor/mcp.json` servers to the agent (ACP otherwise drops unapproved project servers silently). */
  readonly mcpForwardProjectServers: boolean;
  /** The agent's user-level `mcp.json` when set; otherwise found from HOME (see pluginSync.ts). Not forwarded: the CLI loads it itself. */
  readonly mcpUserConfig: string;
  /** Cursor plugin MCP servers: kept in the user-level mcp.json automatically, switched by hand, or left alone. */
  readonly mcpPluginServers: "auto" | "manual" | "off";
  /** Plugin server ids (`plugin-<plugin>-<server>`) that auto mode leaves out. */
  readonly mcpPluginExclude: ReadonlyArray<string>;
  /** Link Cursor plugin skills and commands into the agent's Cursor folder (see cursorPluginSkills.ts). */
  readonly pluginSkills: boolean;
  /** Plugin names, or `plugin/skill`, whose skills are left out. */
  readonly pluginSkillsExclude: ReadonlyArray<string>;
  readonly resumeLastSession: boolean;
  readonly sendWithCtrlEnter: boolean;
  readonly showThoughts: boolean;
  readonly notifyWhenHidden: boolean;
  /** Show the Open Cursor button in the editor title bar. */
  readonly editorTitleButton: boolean;
  readonly protocolLogging: boolean;
  readonly approvalPolicy: ApprovalPolicy;
  /** Regular expressions; see DEFAULT_SAFE_LIST. */
  readonly safeList: ReadonlyArray<string>;
  readonly hiddenModels: ReadonlyArray<string>;
  /** Model used for new sessions; empty = whatever Cursor's CLI currently defaults to. */
  readonly defaultModel: string;
  /** Option values (effort, context, fast…) applied to new sessions. */
  readonly defaultModelOptions: Readonly<Record<string, string | boolean>>;
  /** Where the effective values come from, per key: "default" | "user" | "workspace" | "remote". */
  readonly sources: Readonly<Record<string, "default" | "user" | "workspace" | "remote">>;
}

export type SettingsKey = keyof Omit<ExtensionSettings, "sources" | "agentPathKey">;

/** Result of probing the configured executable (resolve on disk + `--version`). */
export interface AgentProbe {
  readonly state: "checking" | "ok" | "notFound" | "failed";
  readonly configuredPath: string;
  readonly resolvedPath?: string;
  readonly version?: string;
  readonly error?: string;
  readonly hint?: string;
  readonly checkedAt: number;
}

/** An MCP server the extension passes to the agent itself (see mcpConfig.ts). */
export interface McpForwardedServer {
  readonly name: string;
  /** Which config file it came from; the project file wins on a name clash. */
  readonly source: "project" | "user";
  readonly transport: "stdio" | "http" | "sse";
  /** Command (stdio) or URL (http/sse), for display. */
  readonly target: string;
}

/** One line of `agent mcp list`. */
export interface McpCliServer {
  readonly name: string;
  /** The CLI's own wording, e.g. "ready", "needs approval", "disabled". */
  readonly status: string;
  /** The extension forwards a server of this name, so it is available in chat whatever the CLI says. */
  readonly forwarded: boolean;
}

export interface McpConfigFileStatus {
  readonly path: string;
  readonly level: "project" | "user";
  readonly state: "ok" | "missing" | "error";
  readonly detail?: string;
  /** Servers read from the file. */
  readonly count: number;
}

/** An MCP server that comes with an installed Cursor plugin. */
export interface McpPluginServer {
  /** `plugin-<plugin>-<server>`, the name it has in mcp.json and in `agent mcp list`. */
  readonly id: string;
  readonly pluginName: string;
  readonly serverName: string;
  readonly transport: "stdio" | "http" | "sse";
  /** URL host or command base name only (never a query or arguments). */
  readonly host: string;
  /** Listed in the user-level mcp.json (under its id, or another entry with the same URL). */
  readonly enabled: boolean;
  /** On the exclude list (auto mode leaves it out). */
  readonly excluded: boolean;
  /** Its line in `agent mcp list`, e.g. "ready" or "requires_authentication". */
  readonly cliStatus?: string;
}

/** The skills and commands that come with one Cursor plugin. */
export interface McpPluginSkills {
  readonly pluginName: string;
  readonly skills: ReadonlyArray<string>;
  readonly commands: ReadonlyArray<string>;
  /** Linked into the agent's Cursor folder now. */
  readonly linked: ReadonlyArray<string>;
  /** Skipped because a skill or command of that name already exists. */
  readonly clashes: ReadonlyArray<string>;
  /** The whole plugin is on the exclude list. */
  readonly excluded: boolean;
}

/** Where the user-level mcp.json path came from. */
export type McpUserConfigSource = "settings" | "environment" | "agent" | "default";

/** Result of the MCP status check shown in the settings tab (and logged by Show MCP Servers). */
export interface McpStatus {
  readonly checkedAt: number;
  readonly forwarded: ReadonlyArray<McpForwardedServer>;
  readonly files: ReadonlyArray<McpConfigFileStatus>;
  /** What `agent mcp list` reported, or why it could not be asked. */
  readonly cli: ReadonlyArray<McpCliServer> | { readonly error: string };
  /** The executable used for `mcp list`, when found. */
  readonly cliCommand?: string;
  /** Why project servers are not forwarded (setting off, untrusted workspace, no folder), if they are not. */
  readonly projectSkipped?: string;
  /** Cursor plugin servers found under `<cursor dir>/plugins`. */
  readonly plugins?: ReadonlyArray<McpPluginServer>;
  readonly pluginMode?: "auto" | "manual" | "off";
  readonly pluginsDir?: string;
  /** Plugin files that could not be read, and user mcp.json problems. */
  readonly pluginErrors?: ReadonlyArray<string>;
  /** The resolved user-level mcp.json, and how it was found. */
  readonly userConfigPath?: string;
  readonly userConfigSource?: McpUserConfigSource;
  /** The user-level mcp.json or the plugin skill links changed after the running agent read them. */
  readonly reconnectNeeded?: boolean;
  /** Plugins that come with skills or commands, and whether linking them is on. */
  readonly pluginSkills?: ReadonlyArray<McpPluginSkills>;
  readonly pluginSkillsOn?: boolean;
  /** The agent's skills folder is shared (a link or a git repository), so nothing is linked into it. */
  readonly pluginSkillsShared?: boolean;
}

// ---------------------------------------------------------------------------
// Messages: webview -> extension
// ---------------------------------------------------------------------------

export interface PromptAttachmentInput {
  readonly kind: "selection" | "file" | "image";
  readonly label: string;
  readonly path?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  /** Selection / file text captured at attach time. */
  readonly text?: string;
  /** Images: base64 payload (no data: prefix) and mime type. */
  readonly data?: string;
  readonly mimeType?: string;
}

export type WebviewToExtension =
  | { readonly type: "ready" }
  | { readonly type: "prompt"; readonly text: string; readonly attachments: ReadonlyArray<PromptAttachmentInput>; readonly mode?: "queue" | "interrupt" }
  | { readonly type: "cancel" }
  | { readonly type: "queue.sendNow"; readonly index: number }
  | { readonly type: "queue.edit"; readonly index: number }
  | { readonly type: "queue.clear"; readonly index?: number }
  | { readonly type: "queue.move"; readonly from: number; readonly to: number }
  | { readonly type: "permission.respond"; readonly requestId: string; readonly optionId: string; readonly scope?: "session" }
  | { readonly type: "approvals.set"; readonly policy: ApprovalPolicy }
  | { readonly type: "model.saveDefault" }
  | { readonly type: "question.respond"; readonly requestId: string; readonly answers: ReadonlyArray<QuestionAnswer> }
  | { readonly type: "question.skip"; readonly requestId: string }
  | { readonly type: "plan.respond"; readonly requestId: string; readonly accepted: boolean; readonly reason?: string }
  | { readonly type: "session.new" }
  | { readonly type: "session.load"; readonly sessionId: string }
  /** Opens a copy of the session that ends with the agent turn answering this user message. */
  | { readonly type: "session.fork"; readonly userItemId: string }
  | { readonly type: "session.list" }
  | { readonly type: "session.rename"; readonly sessionId: string; readonly title?: string }
  | { readonly type: "session.hide"; readonly sessionId: string }
  /** Hides or unhides several sessions (history pane bulk actions). */
  | { readonly type: "sessions.setHidden"; readonly sessionIds: ReadonlyArray<string>; readonly hidden: boolean }
  | { readonly type: "session.reconnect" }
  | { readonly type: "mode.set"; readonly modeId: string }
  | { readonly type: "model.set"; readonly modelId: string }
  | { readonly type: "config.set"; readonly configId: string; readonly value: string | boolean }
  | { readonly type: "openFile"; readonly path: string; readonly line?: number }
  | { readonly type: "openDiff"; readonly itemId: string; readonly path: string }
  | { readonly type: "copy"; readonly text: string }
  /** Opens VS Code's own settings editor filtered to this extension. */
  | { readonly type: "openSettings" }
  /** Opens (or reveals) the Cursor Agent settings editor tab, optionally on a section. */
  | { readonly type: "settings.open"; readonly section?: SettingsSection }
  | { readonly type: "mcp.status" }
  /** Opens the workspace's `.cursor/mcp.json`, creating it when missing. */
  | { readonly type: "mcp.openConfig" }
  /** Makes Cursor plugin servers available in chat or not (see pluginSync.ts). */
  | { readonly type: "mcp.plugins.set"; readonly ids: ReadonlyArray<string>; readonly enabled: boolean }
  /** Makes a plugin's skills available in chat or not. */
  | { readonly type: "plugins.skills.set"; readonly plugins: ReadonlyArray<string>; readonly enabled: boolean }
  /** Runs `agent mcp login <id>` in a terminal in the workspace folder. */
  | { readonly type: "mcp.plugins.login"; readonly id: string }
  /** Opens the resolved user-level mcp.json. */
  | { readonly type: "mcp.openUserConfig" }
  | { readonly type: "openLogs" }
  | { readonly type: "openExternal"; readonly url: string }
  | { readonly type: "attachActiveFile" }
  | { readonly type: "attachUris"; readonly uris: ReadonlyArray<string> }
  | { readonly type: "pickFiles" }
  | { readonly type: "draft"; readonly text: string }
  | { readonly type: "usage.refresh" }
  | { readonly type: "settings.get" }
  | { readonly type: "settings.update"; readonly key: SettingsKey; readonly value: string | boolean | ReadonlyArray<string> | Readonly<Record<string, string>> }
  | { readonly type: "settings.probe" }
  | { readonly type: "settings.browseAgent" }
  | { readonly type: "settings.reset"; readonly key: SettingsKey }
  | { readonly type: "setup.install" }
  | { readonly type: "setup.login" }
  | { readonly type: "files.search"; readonly query: string; readonly requestId: number };

// ---------------------------------------------------------------------------
// Messages: extension -> webview
// ---------------------------------------------------------------------------

export type ExtensionToWebview =
  | { readonly type: "snapshot"; readonly session: SessionState; readonly items: ReadonlyArray<ThreadItem>; readonly settings: UiSettings; readonly draft?: string }
  | { readonly type: "session"; readonly session: SessionState }
  | { readonly type: "settings"; readonly settings: UiSettings }
  | { readonly type: "item.upsert"; readonly item: ThreadItem }
  | { readonly type: "item.append"; readonly id: string; readonly field: "text" | "output"; readonly text: string }
  | { readonly type: "items.reset"; readonly items: ReadonlyArray<ThreadItem> }
  | { readonly type: "sessions"; readonly sessions: ReadonlyArray<SessionSummary>; readonly loading: boolean; readonly error?: string }
  | { readonly type: "composer.insert"; readonly text: string }
  | { readonly type: "composer.attach"; readonly attachment: PromptAttachmentInput }
  | { readonly type: "composer.focus" }
  | { readonly type: "usage"; readonly usage: UsageSummary | undefined; readonly loading: boolean }
  | { readonly type: "extensionSettings"; readonly settings: ExtensionSettings }
  | { readonly type: "agentProbe"; readonly probe: AgentProbe }
  /** Settings tab: switch to a section (sent when an already-open tab is revealed for a specific section). */
  | { readonly type: "showSettings"; readonly section?: SettingsSection }
  /** Chat: open the session history pane (the Session History command). */
  | { readonly type: "showHistory" }
  | { readonly type: "mcpStatus"; readonly status: McpStatus | undefined; readonly loading: boolean }
  | { readonly type: "setupStatus"; readonly status: { readonly phase: "idle" | "installing" | "loggingIn"; readonly text?: string } }
  | { readonly type: "files.results"; readonly requestId: number; readonly query: string; readonly files: ReadonlyArray<{ readonly path: string; readonly name: string }> }
  | { readonly type: "toast"; readonly level: "info" | "warning" | "error"; readonly text: string };
