/**
 * SessionRuntime owns one Cursor ACP process + session for a workspace folder
 * and exposes a simple imperative API to the view layer.
 *
 * Lifecycle: idle → starting → (loading) → ready ⇄ running/cancelling
 *            any → disconnected (process exit) → reconnect → starting…
 */
import type * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { AcpConnection, type AcpClientHandlers, type CursorAskQuestionRequest, type CursorAskQuestionResponse, type CursorAvailableModel, type CursorCreatePlanRequest, type CursorCreatePlanResponse, type CursorUpdateTodosRequest } from "../acp/AcpConnection";
import { AgentProcess, AgentProcessError } from "../acp/AgentProcess";
import { JsonRpcClosedError, JsonRpcRemoteError, type JsonRpcLogger } from "../acp/jsonrpc";
import type { ApprovalPolicy, ConfigOption, ConnectionState, ExtensionToWebview, PermissionOption, PromptAttachmentInput, Question, QuestionAnswer, SessionState, SessionSummary, ToolItem, UserAttachment, UserItem } from "../../shared/protocol";
import { compileSafeList, isSafe, sessionKey, subjectFrom, type CompiledSafeList, type PermissionSubject } from "./approvals";
import { acpSessionsDirCandidates, findSessionDir, forkSession } from "./forkStore";
import { ThreadModel, isRecord } from "./ThreadModel";

export interface AgentLaunchConfig {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly protocolLogging: boolean;
}

export interface ModelPreferences {
  readonly modelId?: string;
  readonly options?: Readonly<Record<string, string | boolean>>;
}

/** Local, per-user tweaks to Cursor's session list: renamed titles and hidden sessions (ACP has neither). */
export interface SessionMeta {
  readonly titles: Readonly<Record<string, string>>;
  readonly hidden: ReadonlyArray<string>;
  /** Each session's own model and option choices, re-applied on resume (Cursor stores them globally). */
  readonly models?: Readonly<Record<string, ModelPreferences>>;
}

export interface RuntimeStorage {
  getLastSessionId(): string | undefined;
  setLastSessionId(sessionId: string | undefined): void;
  getSessionMeta(): SessionMeta;
  setSessionMeta(meta: SessionMeta): void;
}

export interface RuntimeLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  protocol(direction: "in" | "out", line: string): void;
  stderr(text: string): void;
}

/** Supplies the MCP servers to forward with session/new and session/load (see mcpConfig.ts). */
export type McpServersProvider = () => Promise<ReadonlyArray<acp.McpServer>>;

/**
 * Work around each agent launch (see pluginSync.ts). `afterInitialize` returns
 * true when it changed config the agent reads at startup; the agent is then
 * restarted once, before any session is opened.
 */
export interface AgentLaunchHooks {
  beforeSpawn?(launch: AgentLaunchConfig): Promise<void>;
  afterInitialize?(launch: AgentLaunchConfig, pid: number | undefined): Promise<boolean>;
}

export interface RuntimeEvents {
  /** Any message for attached webviews. */
  message(message: ExtensionToWebview): void;
  /** The configured executable could not be launched (missing / not executable). */
  agentUnavailable?(error: string): void;
  permissionRequested(title: string): void;
  turnFinished(stopReason: string): void;
  questionAsked(title: string): void;
}

export interface SessionRuntimeOptions {
  readonly cwd: string;
  readonly workspaceName: string;
  readonly remoteName?: string;
  readonly getLaunchConfig: () => AgentLaunchConfig;
  /** Approval defaults from settings; read on every session start and permission request. */
  readonly getApprovalConfig: () => { policy: ApprovalPolicy; safeList: ReadonlyArray<string> };
  /** Model + option defaults for new sessions, from settings. */
  readonly getModelDefaults: () => ModelPreferences;
  /** Optional; when absent nothing is forwarded and the CLI loads its own config (approval-gated for project files). */
  readonly getMcpServers?: McpServersProvider;
  readonly launchHooks?: AgentLaunchHooks;
  /** The plugin a slash command comes from (a plugin skill the extension linked), for the slash menu. */
  readonly describeCommand?: (name: string) => { readonly pluginName: string; readonly description?: string } | undefined;
  /**
   * Awaited before every launch, ahead of reading the launch config (the login-shell PATH lookup).
   * Starts can therefore be requested right away: they queue in order instead of racing the wait.
   */
  readonly beforeConnect?: () => Promise<void>;
  /** Folders that may hold Cursor's `acp-sessions` (for forking); defaults to the CLI's own lookup on the launch env. */
  readonly getSessionsDirs?: () => ReadonlyArray<string>;
  readonly storage: RuntimeStorage;
  readonly log: RuntimeLogger;
  readonly events: RuntimeEvents;
}

interface PendingRequest<T> {
  resolve(value: T, resolution?: "user" | "session" | "auto"): void;
  cancel(): void;
}

interface StartRequest {
  target: string | undefined;
  epoch: number;
  promise: Promise<void>;
}

const SESSION_LOAD_TIMEOUT_MS = 90_000;
const CANCEL_TIMEOUT_MS = 15_000;
const STARTUP_TIMEOUT_MS = 60_000;
const AUTHENTICATE_TIMEOUT_MS = 5 * 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function describeError(error: unknown): { text: string; detail?: string } {
  if (error instanceof AgentProcessError) {
    return { text: error.message, ...(error.hint ? { detail: error.hint } : {}) };
  }
  if (error instanceof JsonRpcRemoteError) {
    const data = error.data !== undefined ? `\n${JSON.stringify(error.data, null, 2)}` : "";
    return { text: `${error.method} failed: ${error.message}`, detail: `JSON-RPC error ${error.code}${data}` };
  }
  if (error instanceof JsonRpcClosedError) {
    return { text: error.message };
  }
  if (error instanceof Error) {
    return { text: error.message };
  }
  return { text: String(error) };
}

/**
 * Cursor encodes model parameters in the model id: `grok-4.7[context=256k,reasoning_effort=high,fast=true]`.
 * Split it into the base id and the parameter map (which mirrors the per-model config options).
 */
export function parseCursorModelId(raw: string): { modelId: string; params: Record<string, string> } {
  const match = /^([^[]+)\[(.*)\]$/.exec(raw.trim());
  if (!match) return { modelId: raw.trim(), params: {} };
  const params: Record<string, string> = {};
  for (const part of match[2]!.split(",")) {
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return { modelId: match[1]!.trim(), params };
}

function toConfigOption(option: acp.SessionConfigOption): ConfigOption {
  const options: ConfigOption["options"] =
    option.type === "select"
      ? option.options.flatMap((entry) =>
          "value" in entry
            ? [{ value: entry.value, name: entry.name, ...(entry.description ? { description: entry.description } : {}) }]
            : entry.options.map((sub) => ({ value: sub.value, name: sub.name, ...(sub.description ? { description: sub.description } : {}) })),
        )
      : [];
  return {
    id: option.id,
    name: option.name,
    ...(option.description ? { description: option.description } : {}),
    ...(option.category ? { category: option.category } : {}),
    type: option.type,
    currentValue: option.currentValue as string | boolean,
    options,
  };
}

export class SessionRuntime {
  readonly model: ThreadModel;
  private process: AgentProcess | undefined;
  private connection: AcpConnection | undefined;
  private initializeResult: acp.InitializeResponse | undefined;
  private authenticated = false;
  private connectionGeneration = 0;
  private disposed = false;

  private connectionState: ConnectionState = "idle";
  private sessionId: string | undefined;
  /** Cursor has this session on disk (it was resumed or received a prompt), so it can be loaded again. */
  private sessionPersisted = false;
  private title: string | undefined;
  private modes: SessionState["modes"];
  private models: SessionState["models"];
  private configOptions: ConfigOption[] = [];
  private modelCatalog: CursorAvailableModel[] = [];
  /** Values we set via session/set_config_option, keyed by model id (the catalog may lag behind). */
  private readonly modelOptionOverrides = new Map<string, Record<string, string | boolean>>();
  private availableCommands: SessionState["availableCommands"] = [];
  private lastError: string | undefined;
  /** Cursor reported that no login exists on this machine (authenticate failed / "Authentication required"). */
  private authRequired = false;
  private loginUrl: string | undefined;
  private agentVersion: string | undefined;

  private activePrompt: Promise<acp.PromptResponse> | undefined;
  /** Messages queued while a turn runs, in order; sent one per turn when a turn ends (unless the user stopped it). */
  private queue: Array<{ text: string; attachments: PromptAttachmentInput[] }> = [];
  /** Set when the user pressed Stop, so a queued message waits instead of firing into the cancelled turn. */
  private stoppedByUser = false;
  /** Set while an interrupt-and-send is cancelling the current turn, so the queue does not auto-send over it. */
  private interrupting = false;
  /** Client-side approval policy for the current session (starts from the settings default). */
  private approvalPolicy: ApprovalPolicy = "safe";
  /** "Allow for session" keys: command names or Cursor permission patterns. */
  private sessionAllowed = new Set<string>();
  private safeListCache: { source: string; compiled: CompiledSafeList } | undefined;
  private readonly pendingPermissions = new Map<string, PendingRequest<acp.RequestPermissionResponse>>();
  private readonly pendingQuestions = new Map<string, PendingRequest<CursorAskQuestionResponse>>();
  private readonly pendingPlans = new Map<string, PendingRequest<CursorCreatePlanResponse>>();
  private connectPromise: Promise<AcpConnection> | undefined;
  /** The start (new/load) currently executing, and at most one waiting behind it (latest request wins). */
  private startInFlight: StartRequest | undefined;
  private startQueued: StartRequest | undefined;
  /** Bumped by every teardown; a start that began in an older epoch was superseded and fails silently. */
  private teardownEpoch = 0;
  private publishScheduled = false;
  /** Divider text for the next successful session/load, in place of "Resumed session". */
  private loadDivider: string | undefined;
  private forking = false;
  private modelOptionsMemo: { key: string; catalog: ReadonlyArray<CursorAvailableModel>; live: ReadonlyArray<ConfigOption>; overridesVersion: number; value: ConfigOption[] } | undefined;
  private overridesVersion = 0;

  constructor(private readonly options: SessionRuntimeOptions) {
    this.model = new ThreadModel((message) => this.options.events.message(message), options.cwd);
  }

  // --- state ---------------------------------------------------------------------

  get state(): SessionState {
    const modelOptions = this.currentModelOptions();
    let agentCommand = this.process?.displayCommand;
    if (agentCommand === undefined) {
      const launch = this.options.getLaunchConfig();
      agentCommand = [launch.command, ...launch.args, "acp"].join(" ");
    }
    return {
      connection: this.connectionState,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.effectiveTitle() ? { title: this.effectiveTitle() } : {}),
      cwd: this.options.cwd,
      workspaceName: this.options.workspaceName,
      ...(this.options.remoteName ? { remoteName: this.options.remoteName } : {}),
      agentCommand,
      ...(this.agentVersion ? { agentVersion: this.agentVersion } : {}),
      ...(this.modes ? { modes: this.modes } : {}),
      ...(this.models ? { models: this.models } : {}),
      modelOptions,
      availableCommands: this.availableCommands,
      pendingPermissions: this.pendingPermissions.size,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.authRequired ? { authRequired: true } : {}),
      ...(this.loginUrl ? { loginUrl: this.loginUrl } : {}),
      changedFiles: this.model.changedFiles(),
      ...(this.model.turnStart ? { turnStartedAt: this.model.turnStart } : {}),
      ...(this.queue.length > 0 ? { queued: this.queue.map((q) => ({ text: q.text, attachmentCount: q.attachments.length })) } : {}),
      approvalPolicy: this.approvalPolicy,
      sessionAllowed: [...this.sessionAllowed],
    };
  }

  /** Resolved executable path of the running (or configured) agent. */
  get agentExecutable(): string {
    return this.process?.resolvedCommand ?? this.options.getLaunchConfig().command;
  }

  get isRunning(): boolean {
    return this.connectionState === "running" || this.connectionState === "cancelling";
  }

  get hasSession(): boolean {
    return this.sessionId !== undefined && this.connection !== undefined && !this.connection.isClosed;
  }

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.publishState();
  }

  /**
   * Publishes the session state to the UI on the next microtask. A synchronous
   * burst of calls (tool updates, config changes and permission bookkeeping
   * often publish several times in a row) builds and sends `state` once.
   */
  private publishState(): void {
    if (this.publishScheduled) return;
    this.publishScheduled = true;
    queueMicrotask(() => {
      this.publishScheduled = false;
      this.options.events.message({ type: "session", session: this.state });
    });
  }

  private currentModelOptions(): ConfigOption[] {
    const current = this.models?.currentModelId;
    if (!current) return [];
    const memo = this.modelOptionsMemo;
    if (memo && memo.key === current && memo.catalog === this.modelCatalog && memo.live === this.configOptions && memo.overridesVersion === this.overridesVersion) {
      return memo.value;
    }
    const entry = this.modelCatalog.find((m) => m.value === current);
    const fromCatalog = entry?.configOptions?.map(toConfigOption) ?? [];
    const overrides = this.modelOptionOverrides.get(current) ?? {};
    // Prefer live values from configOptions (session/set_config_option responses), then our own writes.
    const value = fromCatalog.map((option) => {
      const live = this.configOptions.find((c) => c.id === option.id);
      const override = overrides[option.id];
      return override !== undefined ? { ...option, currentValue: override } : live ? { ...option, currentValue: live.currentValue } : option;
    });
    this.modelOptionsMemo = { key: current, catalog: this.modelCatalog, live: this.configOptions, overridesVersion: this.overridesVersion, value };
    return value;
  }

  private setModelOptionOverrides(modelId: string, values: Record<string, string | boolean>): void {
    this.modelOptionOverrides.set(modelId, values);
    this.overridesVersion += 1;
  }

  // --- connection ------------------------------------------------------------------

  /** Spawns the agent and completes initialize + authenticate. Idempotent while alive. */
  private ensureConnected(): Promise<AcpConnection> {
    if (this.connection && !this.connection.isClosed && this.authenticated) return Promise.resolve(this.connection);
    if (!this.connectPromise) {
      this.connectPromise = this.connect().finally(() => {
        this.connectPromise = undefined;
      });
    }
    return this.connectPromise;
  }

  private async connect(allowRestart = true): Promise<AcpConnection> {
    if (this.connection && !this.connection.isClosed && this.authenticated) return this.connection;
    if (this.disposed) throw new JsonRpcClosedError("initialize", "The extension is shutting down.");
    if (this.options.beforeConnect && allowRestart) {
      await this.options.beforeConnect();
      if (this.disposed) throw new JsonRpcClosedError("initialize", "The extension is shutting down.");
    }
    const launch = this.options.getLaunchConfig();
    const hooks = this.options.launchHooks;
    if (hooks?.beforeSpawn && allowRestart) {
      try {
        await hooks.beforeSpawn(launch);
      } catch (error) {
        this.options.log.warn(`Pre-launch step failed: ${describeError(error).text}`);
      }
    }
    const epoch = this.teardownEpoch;
    const generation = ++this.connectionGeneration;
    this.options.log.info(`Launching Cursor agent: ${launch.command} ${[...launch.args, "acp"].join(" ")} (cwd: ${this.options.cwd})`);
    const process = await AgentProcess.spawn({
      command: launch.command,
      args: [...launch.args, "acp"],
      cwd: this.options.cwd,
      env: launch.env,
      onStderr: (text) => this.options.log.stderr(text),
    });
    if (this.disposed || epoch !== this.teardownEpoch) {
      // Torn down (dispose / reconnect) while spawning: do not leak the child.
      await process.kill();
      throw new JsonRpcClosedError("initialize", "The connection was closed before the agent finished starting.");
    }
    this.options.log.info(`Agent process started (pid ${process.pid ?? "?"}).`);
    const logger: JsonRpcLogger | undefined = launch.protocolLogging
      ? { incoming: (line) => this.options.log.protocol("in", line), outgoing: (line) => this.options.log.protocol("out", line) }
      : undefined;
    const connection = new AcpConnection(process, this.clientHandlers(generation), logger);
    this.process = process;
    this.connection = connection;
    this.authenticated = false;
    connection.onClose((reason) => this.onConnectionClosed(generation, reason));

    try {
      const init = await withTimeout(
        connection.initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            _meta: { parameterizedModelPicker: true },
          },
          clientInfo: { name: "vscode-cursor-acp", title: "Cursor Agent for VS Code", version: "0.1.0" },
        }),
        STARTUP_TIMEOUT_MS,
        "The agent did not answer `initialize` within 60s.",
      );
      this.initializeResult = init;
      this.agentVersion = init.agentInfo?.version;
      if (allowRestart && hooks?.afterInitialize) {
        let restart = false;
        try {
          restart = await hooks.afterInitialize(launch, process.pid);
        } catch (error) {
          this.options.log.warn(`Post-initialize step failed: ${describeError(error).text}`);
        }
        if (restart && !this.disposed && epoch === this.teardownEpoch && this.connection === connection) {
          // At most once per connect: the relaunch runs with allowRestart off.
          this.options.log.info("Restarting the agent so it loads the updated user-level mcp.json.");
          this.connectionGeneration += 1;
          this.connection = undefined;
          this.process = undefined;
          connection.close("Restarting to load updated MCP config.");
          await process.kill();
          return this.connect(false);
        }
      }
      const authMethod = init.authMethods?.find((m) => m.id === "cursor_login") ?? init.authMethods?.[0];
      if (authMethod) {
        try {
          // When no login exists Cursor tries to open a browser from inside authenticate and, if it
          // can, blocks until the user finishes; if it cannot, it fails fast with the login URL.
          await withTimeout(connection.authenticate(authMethod.id), AUTHENTICATE_TIMEOUT_MS, "Cursor did not finish logging in within 5 minutes.");
        } catch (error) {
          const text = describeError(error).text;
          const url = /https?:\/\/\S+/.exec(text)?.[0];
          this.authRequired = true;
          this.loginUrl = url;
          throw new AgentProcessError(
            "Cursor is not logged in on this machine.",
            url ? `Open the login link and sign in, then connect again.` : "Run `agent login` in a terminal (using the same wrapper/profile) and then connect again.",
          );
        }
      }
      this.authenticated = true;
      this.authRequired = false;
      this.loginUrl = undefined;
      return connection;
    } catch (error) {
      // Retire this connection silently; the caller reports the startup error. Only touch the
      // shared fields if nothing newer has replaced this connection in the meantime.
      if (this.connection === connection) {
        this.connectionGeneration += 1;
        this.connection = undefined;
        this.process = undefined;
      }
      connection.close("Startup failed.");
      await process.kill();
      const stderr = process.stderr.trim();
      if (error instanceof JsonRpcClosedError && stderr) {
        // The agent died during startup (typically: not logged in, bad wrapper). Its stderr is
        // the useful part; surface it the same way as a missing executable.
        throw new AgentProcessError(error.message, stderr.slice(-2000));
      }
      throw error;
    }
  }

  private onConnectionClosed(generation: number, reason: string): void {
    if (generation !== this.connectionGeneration || this.disposed) return;
    const stderr = this.process?.stderr.trim();
    this.options.log.warn(`Agent connection closed: ${reason}`);
    const wasRunning = this.isRunning;
    this.cancelAllPending();
    this.activePrompt = undefined;
    this.connection = undefined;
    this.model.setReplay(false);
    if (wasRunning) this.model.endTurn("error");
    if (this.connectionState === "starting" || this.connectionState === "loading" || this.connectPromise) {
      // A start / connect is awaiting a request that has just been rejected; it reports the failure
      // (with the same reason) so the transcript does not get two notices for one crash.
      return;
    }
    if (this.connectionState !== "idle" && this.connectionState !== "error") {
      this.lastError = reason;
      this.model.addNotice("error", reason, stderr || undefined, ["reconnect", "newSession", "openLogs"]);
      this.setConnectionState("disconnected");
      if (wasRunning) this.options.events.turnFinished("error");
    }
  }

  private clientHandlers(generation: number): AcpClientHandlers {
    const live = () => generation === this.connectionGeneration;
    return {
      sessionUpdate: (notification) => {
        if (!live()) return;
        this.handleSessionUpdate(notification);
      },
      requestPermission: (params, signal) => {
        if (!live()) return Promise.resolve({ outcome: { outcome: "cancelled" } });
        return this.handlePermission(params, signal);
      },
      askQuestion: (params, signal) => {
        if (!live()) return Promise.resolve({ outcome: { outcome: "cancelled" } });
        return this.handleAskQuestion(params, signal);
      },
      createPlan: (params, signal) => {
        if (!live()) return Promise.resolve({ outcome: { outcome: "cancelled" } });
        return this.handleCreatePlan(params, signal);
      },
      updateTodos: (params: CursorUpdateTodosRequest) => {
        if (!live()) return;
        this.model.setTodos(params.todos ?? [], params.merge !== false);
      },
      unknownRequest: async (method, params) => {
        this.options.log.warn(`Unsupported agent request ${method}: ${JSON.stringify(params).slice(0, 500)}`);
        if (method === "cursor/task" || method === "cursor/generate_image") {
          return { outcome: { outcome: "rejected", reason: "Not supported by this client." } };
        }
        throw new JsonRpcRemoteError(method, -32601, `Method not supported by client: ${method}`);
      },
      unknownNotification: (method, params) => {
        this.options.log.info(`Agent notification ${method}: ${JSON.stringify(params).slice(0, 500)}`);
      },
    };
  }

  // --- session setup -----------------------------------------------------------------

  /**
   * Starts (or resumes) the session the view should show.
   *
   * Starts are serialised: one runs at a time and at most one more waits behind
   * it. Repeated requests for the same target share the running start; a
   * different target replaces whatever is waiting (the latest request wins),
   * and every caller's promise settles once its request has run or been
   * superseded.
   */
  start(resumeSessionId?: string): Promise<void> {
    const epoch = this.teardownEpoch;
    if (this.startQueued) {
      this.startQueued.target = resumeSessionId;
      this.startQueued.epoch = epoch;
      return this.startQueued.promise;
    }
    const inFlight = this.startInFlight;
    if (inFlight) {
      if (inFlight.epoch === epoch && inFlight.target === resumeSessionId) return inFlight.promise;
      const queued: StartRequest = { target: resumeSessionId, epoch, promise: Promise.resolve() };
      queued.promise = inFlight.promise.then(() => {
        if (this.startQueued === queued) this.startQueued = undefined;
        // Runs in whatever epoch is current by then: a teardown in between must not make it fail silently.
        return this.runStart(queued.target, this.teardownEpoch);
      });
      this.startQueued = queued;
      return queued.promise;
    }
    return this.runStart(resumeSessionId, epoch);
  }

  private runStart(target: string | undefined, epoch: number): Promise<void> {
    const request: StartRequest = { target, epoch, promise: Promise.resolve() };
    // startInternal never rejects; the finally only clears the slot.
    request.promise = this.startInternal(target, epoch).finally(() => {
      if (this.startInFlight === request) this.startInFlight = undefined;
    });
    this.startInFlight = request;
    return request.promise;
  }

  /** Resolves once any start in progress (running or queued) has settled. */
  private async settleStart(): Promise<void> {
    while (this.startQueued || this.startInFlight) {
      await (this.startQueued ?? this.startInFlight)!.promise;
    }
  }

  private async startInternal(resumeSessionId: string | undefined, epoch: number): Promise<void> {
    if (this.disposed) return;
    this.lastError = undefined;
    this.setConnectionState("starting");
    try {
      const connection = await this.ensureConnected();
      if (resumeSessionId) {
        await this.loadSessionInternal(connection, resumeSessionId);
      } else {
        await this.newSessionInternal(connection);
      }
    } catch (error) {
      if (this.disposed || epoch !== this.teardownEpoch) {
        // Superseded by a reconnect / dispose while in progress: the replacement start owns the UI state.
        this.options.log.info(`Start of session ${resumeSessionId ?? "(new)"} was superseded: ${describeError(error).text}`);
        return;
      }
      const { text, detail } = describeError(error);
      this.options.log.error(`Failed to start session: ${text}${detail ? `\n${detail}` : ""}`);
      this.lastError = text;
      this.sessionId = undefined;
      if (/authentication required|not logged in/i.test(`${text}\n${detail ?? ""}`)) this.authRequired = true;
      if ((error instanceof AgentProcessError || this.authRequired) && this.model.getItems().length === 0) {
        // Missing executable / not logged in on a fresh view: the UI shows a setup card instead of a notice.
        this.setConnectionState("error");
        this.options.events.agentUnavailable?.(text);
        return;
      }
      this.model.addNotice("error", text, detail ?? this.process?.stderr.trim() ?? undefined, ["reconnect", "openSettings", "openLogs"]);
      this.setConnectionState(this.connection && !this.connection.isClosed ? "idle" : "error");
      if (error instanceof AgentProcessError) this.options.events.agentUnavailable?.(text);
    }
  }

  /** MCP servers forwarded with the last session/new or session/load, by name. */
  forwardedMcpServers: ReadonlyArray<string> = [];

  private async mcpServers(): Promise<acp.McpServer[]> {
    if (!this.options.getMcpServers) return [];
    try {
      const servers = [...(await this.options.getMcpServers())];
      this.forwardedMcpServers = servers.map((s) => s.name);
      if (servers.length) this.options.log.info(`Forwarding MCP servers: ${this.forwardedMcpServers.join(", ")}`);
      return servers;
    } catch (error) {
      this.options.log.warn(`Could not read MCP config: ${error instanceof Error ? error.message : String(error)}`);
      this.forwardedMcpServers = [];
      return [];
    }
  }

  private async newSessionInternal(connection: AcpConnection): Promise<void> {
    this.resetSessionState();
    const response = await connection.newSession({ cwd: this.options.cwd, mcpServers: await this.mcpServers() });
    this.sessionId = response.sessionId;
    // Cursor only persists sessions that received a prompt; remember the id on the first prompt.
    this.applySessionSetup(response);
    this.setConnectionState("ready");
    await this.refreshModelCatalog();
    await this.applyModelPreferences(this.options.getModelDefaults());
    this.rememberSessionModel();
    this.options.log.info(`New session ${response.sessionId}`);
  }

  private async loadSessionInternal(connection: AcpConnection, sessionId: string): Promise<void> {
    this.resetSessionState();
    this.sessionId = sessionId;
    // Presumed on disk while it loads, so a reconnect meanwhile reloads it; a failed load resets this.
    this.sessionPersisted = true;
    this.model.setReplay(true);
    this.setConnectionState("loading");
    let response: acp.LoadSessionResponse;
    try {
      response = await withTimeout(
        connection.loadSession({ sessionId, cwd: this.options.cwd, mcpServers: await this.mcpServers() }),
        SESSION_LOAD_TIMEOUT_MS,
        "session/load timed out while replaying history.",
      );
    } catch (error) {
      this.model.setReplay(false);
      if (error instanceof JsonRpcRemoteError) {
        // The session is gone for this agent (never prompted, deleted, or kept by a differently
        // configured agent/profile). Fall back to a fresh session, but keep the stored id: forgetting
        // it made every later window open a new session after one bad start. It is replaced as soon
        // as a prompt is sent here or another session is resumed.
        this.options.log.warn(`Could not resume session ${sessionId}: ${error.message}. Starting a new session.`);
        await this.newSessionInternal(connection);
        this.model.addNotice("info", "The previous session could not be resumed, so a new session was started.", describeError(error).text, []);
        return;
      }
      throw error;
    }
    this.model.setReplay(false);
    this.applySessionSetup(response);
    const divider = this.loadDivider ?? "Resumed session";
    this.loadDivider = undefined;
    if (this.model.getItems().length > 0) {
      this.model.addDivider(divider);
    }
    this.options.storage.setLastSessionId(sessionId);
    this.setConnectionState("ready");
    await this.refreshModelCatalog();
    // Cursor keeps model/options globally, so put back what this session was using.
    const remembered = this.options.storage.getSessionMeta().models?.[sessionId];
    if (remembered) await this.applyModelPreferences(remembered);
    // session/load does not return the title; recover it from the session list when available.
    if (!this.title && this.initializeResult?.agentCapabilities?.sessionCapabilities?.list) {
      try {
        const listed = (await connection.listSessions({ cwd: this.options.cwd })).sessions.find((s) => s.sessionId === sessionId);
        if (listed?.title) {
          this.title = listed.title;
          this.publishState();
        }
      } catch (error) {
        this.options.log.warn(`Could not read the session title: ${describeError(error).text}`);
      }
    }
    this.options.log.info(`Resumed session ${sessionId}`);
  }

  private resetSessionState(): void {
    this.cancelAllPending();
    this.approvalPolicy = this.options.getApprovalConfig().policy;
    this.sessionAllowed.clear();
    this.modelOptionOverrides.clear();
    this.overridesVersion += 1;
    this.model.reset();
    this.sessionId = undefined;
    this.sessionPersisted = false;
    this.title = undefined;
    this.modes = undefined;
    this.models = undefined;
    this.configOptions = [];
    this.availableCommands = [];
    this.activePrompt = undefined;
  }

  private applySessionSetup(response: acp.NewSessionResponse | acp.LoadSessionResponse): void {
    if (response.modes) {
      this.modes = {
        currentModeId: response.modes.currentModeId,
        availableModes: response.modes.availableModes.map((m) => ({ id: m.id, name: m.name, ...(m.description ? { description: m.description } : {}) })),
      };
    }
    // Cursor reports `models` (currentModelId + availableModels) alongside the standard fields.
    const models = (response as { models?: { currentModelId?: unknown; availableModels?: unknown } }).models;
    if (models && typeof models.currentModelId === "string" && Array.isArray(models.availableModels)) {
      const available = models.availableModels.filter(
        (m): m is { modelId: string; name: string; description?: string } =>
          isRecord(m) && typeof m.modelId === "string" && typeof m.name === "string",
      );
      const parsed = parseCursorModelId(models.currentModelId);
      this.models = {
        currentModelId: parsed.modelId,
        availableModels: available.map((m) => ({ modelId: m.modelId, name: m.name, ...(m.description ? { description: m.description } : {}) })),
      };
      this.rememberModelParams(parsed);
    }
    if (response.configOptions) {
      this.applyConfigOptions(response.configOptions);
    }
  }

  private applyConfigOptions(options: ReadonlyArray<acp.SessionConfigOption>): void {
    this.configOptions = options.map(toConfigOption);
    const mode = this.configOptions.find((o) => o.id === "mode" || o.category === "mode");
    if (mode && typeof mode.currentValue === "string") {
      this.modes = {
        currentModeId: mode.currentValue,
        availableModes: mode.options.length > 0 ? mode.options.map((o) => ({ id: o.value, name: o.name, ...(o.description ? { description: o.description } : {}) })) : (this.modes?.availableModes ?? []),
      };
    }
    const model = this.configOptions.find((o) => o.id === "model" || o.category === "model");
    if (model && typeof model.currentValue === "string") {
      const parsed = parseCursorModelId(model.currentValue);
      this.models = {
        currentModelId: parsed.modelId,
        availableModels: model.options.length > 0 ? model.options.map((o) => ({ modelId: o.value, name: o.name, ...(o.description ? { description: o.description } : {}) })) : (this.models?.availableModels ?? []),
      };
      this.rememberModelParams(parsed);
    }
    // The "model" selector itself is never a per-model option; drop its parameterised currentValue from the live list.
    this.configOptions = this.configOptions.map((o) => (o.id === "model" && typeof o.currentValue === "string" ? { ...o, currentValue: parseCursorModelId(o.currentValue).modelId } : o));
  }

  /** Parameters embedded in the model id are the authoritative current values of the model options. */
  private rememberModelParams(parsed: { modelId: string; params: Record<string, string> }): void {
    if (Object.keys(parsed.params).length === 0) return;
    this.setModelOptionOverrides(parsed.modelId, { ...(this.modelOptionOverrides.get(parsed.modelId) ?? {}), ...parsed.params });
  }

  private async refreshModelCatalog(): Promise<void> {
    const connection = this.connection;
    if (!connection || !this.sessionId) return;
    try {
      const response = await connection.listAvailableModels(this.sessionId);
      this.modelCatalog = [...(response.models ?? [])];
      this.publishState();
    } catch (error) {
      this.options.log.warn(`cursor/list_available_models failed: ${describeError(error).text}`);
    }
  }

  /** Writes the current model and option values under the current session id. */
  private rememberSessionModel(): void {
    const sessionId = this.sessionId;
    if (!sessionId || !this.models) return;
    const options: Record<string, string | boolean> = {};
    for (const o of this.currentModelOptions()) options[o.id] = o.currentValue;
    const meta = this.options.storage.getSessionMeta();
    this.options.storage.setSessionMeta({ ...meta, models: { ...(meta.models ?? {}), [sessionId]: { modelId: this.models.currentModelId, options } } });
  }

  private async applyModelPreferences(prefs: ModelPreferences): Promise<void> {
    if (!this.models) return;
    if (prefs.modelId && !this.models.availableModels.some((m) => m.modelId === prefs.modelId)) {
      this.options.log.warn(`Default model ${prefs.modelId} is not available; keeping ${this.models.currentModelId}.`);
    }
    try {
      if (prefs.modelId && prefs.modelId !== this.models.currentModelId && this.models.availableModels.some((m) => m.modelId === prefs.modelId)) {
        await this.setModel(prefs.modelId, false);
      }
      for (const [configId, value] of Object.entries(prefs.options ?? {})) {
        const option = this.currentModelOptions().find((o) => o.id === configId);
        if (!option || option.currentValue === value) continue;
        if (option.options.length > 0 && !option.options.some((o) => o.value === String(value))) continue;
        await this.setConfigOption(configId, value, false);
      }
    } catch (error) {
      this.options.log.warn(`Failed to apply saved model preferences: ${describeError(error).text}`);
    }
  }

  // --- public session commands ------------------------------------------------------------

  async newSession(): Promise<void> {
    if (this.isRunning) await this.cancel();
    await this.start(undefined);
  }

  async loadSession(sessionId: string): Promise<void> {
    if (this.isRunning) await this.cancel();
    await this.start(sessionId);
  }

  /**
   * Copies the current session up to the end of the agent turn that answered a user message, and
   * opens the copy. The current session is left as it is.
   */
  async forkAfterTurn(userItemId: string): Promise<void> {
    if (this.forking) throw new Error("A fork is already in progress.");
    this.forking = true;
    try {
      await this.settleStart();
      if (this.isRunning) throw new Error("Stop the current turn before forking.");
      const sessionId = this.sessionId;
      if (!sessionId || !this.sessionPersisted) throw new Error("This session has not been saved by Cursor yet.");
      const users = this.model.getItems().filter((i): i is UserItem => i.type === "user");
      const index = users.findIndex((u) => u.id === userItemId);
      const item = users[index];
      if (!item) throw new Error("That message is no longer in the transcript.");
      const dirs = this.options.getSessionsDirs?.() ?? acpSessionsDirCandidates(this.options.getLaunchConfig().env);
      const sessionsDir = findSessionDir(dirs, sessionId);
      if (!sessionsDir) throw new Error(`Cursor's saved copy of this session was not found (looked in ${dirs.join(", ")}).`);
      const title = this.effectiveTitle();
      const fork = await forkSession({ sessionsDir, sessionId, turnIndex: index, text: item.text, shownCount: users.length, ...(title ? { title } : {}) });
      this.options.log.info(`Forked session ${sessionId} after turn ${fork.turnIndex + 1} as ${fork.sessionId} (${fork.title})`);
      const meta = this.options.storage.getSessionMeta();
      const prefs = meta.models?.[sessionId];
      if (prefs) this.options.storage.setSessionMeta({ ...meta, models: { ...meta.models, [fork.sessionId]: prefs } });
      this.loadDivider = title ? `Forked from “${title}”` : "Forked session";
      try {
        await this.start(fork.sessionId);
      } finally {
        this.loadDivider = undefined;
      }
    } finally {
      this.forking = false;
    }
  }

  /**
   * The session to reopen after a reconnect or crash: the current one when Cursor has it on disk,
   * a fresh one when the current session never got a prompt (it cannot be loaded), else the stored one.
   */
  private reopenTarget(): string | undefined {
    if (this.sessionId) return this.sessionPersisted ? this.sessionId : undefined;
    return this.options.storage.getLastSessionId();
  }

  /** Re-spawns the agent and reloads the current session (if any). */
  async reconnect(): Promise<void> {
    const sessionId = this.reopenTarget();
    await this.teardownProcess();
    this.setConnectionState("idle");
    await this.start(sessionId);
  }

  /** The session title with the user's local rename applied. */
  private effectiveTitle(): string | undefined {
    const override = this.sessionId ? this.options.storage.getSessionMeta().titles[this.sessionId] : undefined;
    return override?.trim() || this.title;
  }

  /** Stores a local title for a session (empty clears it). Cursor's ACP has no rename, so this never reaches the agent. */
  renameSession(sessionId: string, title: string): void {
    const meta = this.options.storage.getSessionMeta();
    const titles = { ...meta.titles };
    if (title.trim()) titles[sessionId] = title.trim();
    else delete titles[sessionId];
    this.options.storage.setSessionMeta({ ...meta, titles });
    if (sessionId === this.sessionId) this.publishState();
  }

  /** Hides a session from the history list. The session itself is untouched and can still be resumed by id. */
  hideSession(sessionId: string): void {
    const meta = this.options.storage.getSessionMeta();
    if (meta.hidden.includes(sessionId)) return;
    this.options.storage.setSessionMeta({ ...meta, hidden: [...meta.hidden, sessionId] });
  }

  /** Shows or hides several sessions at once (the history pane's bulk actions and Unhide). */
  setSessionsHidden(sessionIds: ReadonlyArray<string>, hide: boolean): void {
    const meta = this.options.storage.getSessionMeta();
    const hidden = new Set(meta.hidden);
    for (const id of sessionIds) {
      if (hide) hidden.add(id);
      else hidden.delete(id);
    }
    if (hidden.size === meta.hidden.length && meta.hidden.every((id) => hidden.has(id))) return;
    this.options.storage.setSessionMeta({ ...meta, hidden: [...hidden] });
  }

  /** Lists this folder's sessions, newest first. Hidden ones are left out unless `includeHidden` (then flagged `hidden`). */
  async listSessions(options: { readonly includeHidden?: boolean } = {}): Promise<SessionSummary[]> {
    const connection = await this.ensureConnected();
    if (!this.initializeResult?.agentCapabilities?.sessionCapabilities?.list) {
      throw new Error("This agent does not support listing sessions.");
    }
    const response = await connection.listSessions({ cwd: this.options.cwd });
    const meta = this.options.storage.getSessionMeta();
    const hidden = new Set(meta.hidden);
    return response.sessions
      .filter((s) => options.includeHidden || !hidden.has(s.sessionId))
      .map((s) => ({
        sessionId: s.sessionId,
        ...(meta.titles[s.sessionId]?.trim() ? { title: meta.titles[s.sessionId] } : s.title ? { title: s.title } : {}),
        ...(s.cwd ? { cwd: s.cwd } : {}),
        ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
        ...(hidden.has(s.sessionId) ? { hidden: true } : {}),
        ...(meta.models?.[s.sessionId]?.modelId ? { modelId: meta.models[s.sessionId]!.modelId } : {}),
      }))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  // --- prompting ---------------------------------------------------------------------

  async prompt(text: string, attachments: ReadonlyArray<PromptAttachmentInput>, mode: "queue" | "interrupt" = "queue"): Promise<void> {
    // A session being created or replayed must finish first; prompting mid-replay would race the
    // history (and, with no session id yet, would wrongly create a fresh session).
    await this.settleStart();
    if (this.disposed) return;
    if (this.isRunning) {
      if (mode === "queue") {
        // One prompt at a time per ACP session: hold the message and send it when this turn ends.
        this.queue.push({ text, attachments: [...attachments] });
        this.publishState();
        return;
      }
      this.options.log.info("Interrupting the current turn to send a new prompt.");
      this.interrupting = true;
      try {
        await this.cancel(false);
      } finally {
        this.interrupting = false;
      }
      if (this.disposed) return;
      if (this.isRunning) {
        // Something else took the slot (should not happen); keep the message rather than lose it.
        this.queue.unshift({ text, attachments: [...attachments] });
        this.publishState();
        return;
      }
    }
    this.stoppedByUser = false;
    if (!this.hasSession) {
      await this.start(this.sessionId && this.sessionPersisted ? this.sessionId : undefined);
      if (!this.hasSession) return;
    }
    const connection = this.connection!;
    const sessionId = this.sessionId!;
    const trimmed = text.trim();
    const blocks: acp.ContentBlock[] = [];
    const uiAttachments: UserAttachment[] = [];
    const contextParts: string[] = [];
    for (const attachment of attachments) {
      if (attachment.kind === "image" && attachment.data && attachment.mimeType) {
        blocks.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType });
        uiAttachments.push({ kind: "image", label: attachment.label, previewDataUrl: `data:${attachment.mimeType};base64,${attachment.data.slice(0, 200_000)}` });
      } else if (attachment.kind === "selection" && attachment.path) {
        const range = attachment.startLine ? `#L${attachment.startLine}${attachment.endLine && attachment.endLine !== attachment.startLine ? `-${attachment.endLine}` : ""}` : "";
        contextParts.push(`Selected code from ${attachment.path}${range}:\n\`\`\`\n${attachment.text ?? ""}\n\`\`\``);
        uiAttachments.push({ kind: "selection", label: attachment.label, path: attachment.path, ...(attachment.startLine ? { startLine: attachment.startLine } : {}), ...(attachment.endLine ? { endLine: attachment.endLine } : {}) });
      } else if (attachment.kind === "file" && attachment.path) {
        contextParts.push(`Referenced file: ${attachment.path}`);
        uiAttachments.push({ kind: "file", label: attachment.label, path: attachment.path });
      } else if (attachment.kind === "file" && attachment.text !== undefined) {
        // Dropped from outside the workspace: the webview only has the contents, not a path.
        contextParts.push(`Contents of ${attachment.label}:\n\`\`\`\n${attachment.text}\n\`\`\``);
        uiAttachments.push({ kind: "file", label: attachment.label });
      }
    }
    const isSlashCommand = /^\/[^\s/]+(?:\s|$)/.test(trimmed);
    const promptText = isSlashCommand || contextParts.length === 0 ? trimmed : `${trimmed}\n\n${contextParts.join("\n\n")}`;
    if (promptText) blocks.unshift({ type: "text", text: promptText });
    if (blocks.length === 0) return;

    this.model.beginTurn(trimmed, uiAttachments);
    this.sessionPersisted = true;
    this.options.storage.setLastSessionId(sessionId);
    this.setConnectionState("running");
    const request = connection.prompt({ sessionId, prompt: blocks });
    this.activePrompt = request;
    let stopReason = "error";
    try {
      const response = await request;
      stopReason = response.stopReason;
      this.options.log.info(`Turn finished: ${stopReason}`);
    } catch (error) {
      if (error instanceof JsonRpcClosedError) {
        // Handled by onConnectionClosed (disconnected notice + turn end).
        return;
      }
      const { text: message, detail } = describeError(error);
      this.options.log.error(`Prompt failed: ${message}`);
      this.model.addNotice("error", message, detail, ["retry"]);
    } finally {
      if (this.activePrompt === request) {
        this.activePrompt = undefined;
        this.cancelAllPending();
        if (this.connectionState === "running" || this.connectionState === "cancelling") {
          this.model.endTurn(stopReason);
          this.setConnectionState("ready");
          this.options.events.turnFinished(stopReason);
        }
        // The next queued message follows on its own unless the user explicitly stopped the turn, in
        // which case the queue stays put so they can reconsider it.
        if (this.queue.length > 0 && !this.stoppedByUser && !this.interrupting && !this.disposed) {
          const next = this.queue.shift()!;
          void this.prompt(next.text, next.attachments);
        }
      }
    }
  }

  /** Sends a queued message now, interrupting the current turn if there is one. */
  async sendQueuedNow(index = 0): Promise<void> {
    const next = this.takeQueued(index);
    if (!next) return;
    await this.prompt(next.text, next.attachments, "interrupt");
  }

  /** Reorders the queue by moving one message to a new position. */
  moveQueued(from: number, to: number): void {
    if (from === to || from < 0 || from >= this.queue.length || to < 0 || to >= this.queue.length) return;
    const [item] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, item!);
    this.publishState();
  }

  /** Removes and returns one queued message (for editing in the composer); no index clears the whole queue. */
  takeQueued(index?: number): { text: string; attachments: PromptAttachmentInput[] } | undefined {
    if (index === undefined) {
      this.queue = [];
      this.publishState();
      return undefined;
    }
    const [next] = this.queue.splice(index, 1);
    if (!next) return undefined;
    this.publishState();
    return next;
  }

  async cancel(byUser = true): Promise<void> {
    const connection = this.connection;
    const sessionId = this.sessionId;
    const active = this.activePrompt;
    if (!connection || !sessionId || !active || connection.isClosed) return;
    if (byUser) this.stoppedByUser = true;
    this.setConnectionState("cancelling");
    this.options.log.info("Cancelling current turn.");
    // Per ACP, pending permission requests must be answered with `cancelled` once we cancel.
    this.cancelAllPending();
    connection.cancel(sessionId);
    try {
      await withTimeout(active.catch(() => undefined), CANCEL_TIMEOUT_MS, "cancel timeout");
    } catch {
      this.options.log.warn("The agent did not acknowledge cancellation in time; stopping the process.");
      this.model.addNotice("warning", "The agent did not stop in time, so its process was terminated.", undefined, ["reconnect"]);
      await this.teardownProcess();
      this.model.endTurn("cancelled");
      this.setConnectionState("disconnected");
    }
  }

  // --- agent → client requests ------------------------------------------------------------

  private compiledSafeList(): CompiledSafeList {
    const list = this.options.getApprovalConfig().safeList;
    const source = JSON.stringify(list);
    if (this.safeListCache?.source !== source) {
      const compiled = compileSafeList(list);
      for (const bad of compiled.invalid) this.options.log.warn(`Ignoring invalid safe-list pattern: ${bad}`);
      this.safeListCache = { source, compiled };
    }
    return this.safeListCache.compiled;
  }

  /** Decides whether a permission request can be answered without asking, and why. */
  private autoDecision(subject: PermissionSubject): "auto" | "session" | undefined {
    if (this.approvalPolicy === "auto") return "auto";
    if (this.sessionAllowed.has(sessionKey(subject))) return "session";
    if (this.approvalPolicy === "safe" && isSafe(subject, this.compiledSafeList())) return "auto";
    return undefined;
  }

  setApprovalPolicy(policy: ApprovalPolicy): void {
    if (this.approvalPolicy === policy) return;
    this.approvalPolicy = policy;
    this.options.log.info(`Approval policy: ${policy}`);
    // A switch to a more permissive policy resolves anything already waiting.
    for (const [requestId, pending] of this.pendingPermissions) {
      const item = this.model.getItems().find((i): i is ToolItem => i.type === "tool" && i.permission?.requestId === requestId);
      if (!item) continue;
      const decision = this.autoDecision(this.subjectOf(item));
      if (decision) pending.resolve({ outcome: { outcome: "selected", optionId: this.allowOnceOption(item.permission!.options) } }, decision);
    }
    this.publishState();
  }

  private subjectOf(item: ToolItem): PermissionSubject {
    return subjectFrom({ ...(item.command ? { command: item.command } : {}), title: item.title, ...(item.permission?.reason ? { reason: item.permission.reason } : {}), ...(item.mcpPattern ? { pattern: item.mcpPattern } : {}) });
  }

  private allowOnceOption(options: ReadonlyArray<PermissionOption>): string {
    return (options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind === "allow_always") ?? options[0])!.optionId;
  }

  private handlePermission(params: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    const requestId = randomUUID();
    const item = this.model.attachPermission(params, requestId);
    const subject = this.subjectOf(item);
    const decision = this.autoDecision(subject);
    if (decision) {
      const optionId = this.allowOnceOption(item.permission!.options);
      this.options.log.info(`Permission ${decision === "auto" ? "auto-approved" : "allowed for session"}: ${item.command ?? item.title}`);
      this.model.resolvePermission(requestId, optionId, decision);
      return Promise.resolve({ outcome: { outcome: "selected", optionId } });
    }
    this.options.log.info(`Permission requested: ${item.title}`);
    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      const finish = (response: acp.RequestPermissionResponse, selected: string | undefined, resolution: "user" | "session" | "auto" = "user") => {
        if (!this.pendingPermissions.delete(requestId)) return;
        this.model.resolvePermission(requestId, selected, resolution);
        this.publishState();
        resolve(response);
      };
      this.pendingPermissions.set(requestId, {
        resolve: (response, resolution) => finish(response, response.outcome.outcome === "selected" ? response.outcome.optionId : undefined, resolution),
        cancel: () => finish({ outcome: { outcome: "cancelled" } }, undefined),
      });
      signal.addEventListener("abort", () => finish({ outcome: { outcome: "cancelled" } }, undefined));
      this.publishState();
      this.options.events.permissionRequested(item.command ?? item.title);
    });
  }

  respondToPermission(requestId: string, optionId: string, scope?: "session"): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    if (scope === "session") {
      const item = this.model.getItems().find((i): i is ToolItem => i.type === "tool" && i.permission?.requestId === requestId);
      if (item) {
        const key = sessionKey(this.subjectOf(item));
        this.sessionAllowed.add(key);
        this.options.log.info(`Permission ${requestId}: ${optionId} (allowed for session: ${key})`);
        pending.resolve({ outcome: { outcome: "selected", optionId } }, "session");
        return;
      }
    }
    this.options.log.info(`Permission ${requestId}: ${optionId}`);
    pending.resolve({ outcome: { outcome: "selected", optionId } }, "user");
  }

  private handleAskQuestion(params: CursorAskQuestionRequest, signal: AbortSignal): Promise<CursorAskQuestionResponse> {
    const requestId = randomUUID();
    const questions: Question[] = (params.questions ?? []).map((q) => ({
      id: q.id,
      prompt: q.prompt,
      options: (q.options ?? []).map((o) => ({ id: o.id, label: o.label })),
      allowMultiple: q.allowMultiple === true,
    }));
    this.model.addQuestion(requestId, params.title, questions);
    this.options.events.questionAsked(params.title ?? questions[0]?.prompt ?? "The agent has a question");
    return new Promise<CursorAskQuestionResponse>((resolve) => {
      const finish = (response: CursorAskQuestionResponse) => {
        if (!this.pendingQuestions.delete(requestId)) return;
        const state = response.outcome.outcome === "answered" ? "answered" : response.outcome.outcome === "skipped" ? "skipped" : "cancelled";
        this.model.resolveQuestion(requestId, state, response.outcome.outcome === "answered" ? response.outcome.answers : undefined);
        resolve(response);
      };
      this.pendingQuestions.set(requestId, { resolve: finish, cancel: () => finish({ outcome: { outcome: "cancelled" } }) });
      signal.addEventListener("abort", () => finish({ outcome: { outcome: "cancelled" } }));
    });
  }

  respondToQuestion(requestId: string, answers: ReadonlyArray<QuestionAnswer>): void {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return;
    pending.resolve({
      outcome: {
        outcome: "answered",
        answers: answers.map((a) => ({ questionId: a.questionId, selectedOptionIds: a.selectedOptionIds, ...(a.text ? { text: a.text } : {}) })),
      },
    });
  }

  skipQuestion(requestId: string): void {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return;
    pending.resolve({ outcome: { outcome: "skipped", reason: "The user skipped the question." } });
  }

  private handleCreatePlan(params: CursorCreatePlanRequest, signal: AbortSignal): Promise<CursorCreatePlanResponse> {
    const requestId = randomUUID();
    this.model.addPlanProposal(requestId, {
      ...(params.name ? { name: params.name } : {}),
      ...(params.overview ? { overview: params.overview } : {}),
      plan: params.plan || "(The agent did not include plan text.)",
      todos: params.todos ?? params.phases?.flatMap((p) => p.todos) ?? [],
    });
    this.options.events.questionAsked(params.name ? `Plan: ${params.name}` : "The agent proposed a plan");
    return new Promise<CursorCreatePlanResponse>((resolve) => {
      const finish = (response: CursorCreatePlanResponse) => {
        if (!this.pendingPlans.delete(requestId)) return;
        this.model.resolvePlanProposal(requestId, response.outcome.outcome === "accepted" ? "accepted" : response.outcome.outcome === "rejected" ? "rejected" : "cancelled");
        resolve(response);
      };
      this.pendingPlans.set(requestId, { resolve: finish, cancel: () => finish({ outcome: { outcome: "cancelled" } }) });
      signal.addEventListener("abort", () => finish({ outcome: { outcome: "cancelled" } }));
    });
  }

  respondToPlan(requestId: string, accepted: boolean, reason?: string): void {
    const pending = this.pendingPlans.get(requestId);
    if (!pending) return;
    pending.resolve(accepted ? { outcome: { outcome: "accepted" } } : { outcome: { outcome: "rejected", ...(reason ? { reason } : {}) } });
  }

  private cancelAllPending(): void {
    for (const pending of [...this.pendingPermissions.values(), ...this.pendingQuestions.values(), ...this.pendingPlans.values()]) {
      pending.cancel();
    }
  }

  // --- session updates ----------------------------------------------------------------------

  private handleSessionUpdate(notification: acp.SessionNotification): void {
    if (this.sessionId && notification.sessionId !== this.sessionId) {
      // Updates for a session we are not showing (should not happen with one session per process).
      return;
    }
    const update = notification.update;
    const changedBefore = this.model.changedFilesVersion;
    if (this.model.applyUpdate(update)) {
      // The changed-files summary in the header only moves when a finished edit lands.
      if (this.model.changedFilesVersion !== changedBefore) this.publishState();
      return;
    }
    switch (update.sessionUpdate) {
      case "available_commands_update":
        this.availableCommands = update.availableCommands.map((c) => {
          const plugin = this.options.describeCommand?.(c.name);
          // Cursor shows a command file's first line ("---" when it has frontmatter) as its description.
          const description = plugin?.description && (!c.description || /^-{3,}/.test(c.description.trim())) ? plugin.description : c.description;
          return {
            name: c.name,
            description,
            ...(c.input && "hint" in c.input && c.input.hint ? { hint: c.input.hint } : {}),
            ...(plugin ? { plugin: plugin.pluginName } : {}),
          };
        });
        this.publishState();
        return;
      case "current_mode_update":
        if (this.modes) this.modes = { ...this.modes, currentModeId: update.currentModeId };
        this.publishState();
        return;
      case "config_option_update":
        this.applyConfigOptions(update.configOptions);
        this.publishState();
        return;
      case "session_info_update":
        if (typeof update.title === "string" && update.title.trim()) this.title = update.title.trim();
        this.publishState();
        return;
      default: {
        const kind = (update as { sessionUpdate?: string }).sessionUpdate ?? "unknown";
        this.options.log.info(`Ignoring session update: ${kind}`);
      }
    }
  }

  // --- configuration -----------------------------------------------------------------------

  async setMode(modeId: string): Promise<void> {
    const connection = this.connection;
    if (!connection || !this.sessionId) return;
    try {
      const hasModeOption = this.configOptions.some((o) => o.id === "mode");
      if (hasModeOption) {
        const response = await connection.setConfigOption({ sessionId: this.sessionId, configId: "mode", value: modeId });
        if (response.configOptions) this.applyConfigOptions(response.configOptions);
      } else {
        await connection.setMode({ sessionId: this.sessionId, modeId });
      }
      if (this.modes) this.modes = { ...this.modes, currentModeId: modeId };
      this.publishState();
    } catch (error) {
      this.toastError("Could not switch mode", error);
    }
  }

  async setModel(modelId: string, persist = true): Promise<void> {
    const connection = this.connection;
    if (!connection || !this.sessionId) return;
    try {
      const response = await connection.setConfigOption({ sessionId: this.sessionId, configId: "model", value: modelId });
      if (response.configOptions) this.applyConfigOptions(response.configOptions);
      if (this.models) this.models = { ...this.models, currentModelId: modelId };
      this.publishState();
      await this.refreshModelCatalog();
      if (persist) this.rememberSessionModel();
    } catch (error) {
      this.toastError("Could not switch model", error);
    }
  }

  async setConfigOption(configId: string, value: string | boolean, persist = true): Promise<void> {
    const connection = this.connection;
    if (!connection || !this.sessionId) return;
    try {
      const response = await connection.setConfigOption({ sessionId: this.sessionId, configId, value: value as string });
      if (response.configOptions) this.applyConfigOptions(response.configOptions);
      // Model-specific options are only reported by cursor/list_available_models, which may lag; remember our write.
      if (this.models) {
        const modelId = this.models.currentModelId;
        this.setModelOptionOverrides(modelId, { ...(this.modelOptionOverrides.get(modelId) ?? {}), [configId]: value });
      }
      this.publishState();
      await this.refreshModelCatalog();
      if (persist) this.rememberSessionModel();
    } catch (error) {
      this.toastError("Could not update option", error);
    }
  }

  private toastError(prefix: string, error: unknown): void {
    const { text } = describeError(error);
    this.options.log.error(`${prefix}: ${text}`);
    this.options.events.message({ type: "toast", level: "error", text: `${prefix}: ${text}` });
  }

  // --- teardown -----------------------------------------------------------------------------

  private async teardownProcess(): Promise<void> {
    this.teardownEpoch += 1;
    this.connectionGeneration += 1;
    this.cancelAllPending();
    const connection = this.connection;
    const process = this.process;
    this.connection = undefined;
    this.process = undefined;
    this.activePrompt = undefined;
    this.authenticated = false;
    connection?.close("Connection closed by the extension.");
    if (process) await process.kill();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.teardownProcess();
  }
}
