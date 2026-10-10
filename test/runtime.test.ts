import { DEFAULT_SAFE_LIST } from "../src/extension/session/approvals";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionToWebview, ThreadItem, ToolItem } from "../src/shared/protocol";
import { SessionRuntime, type AgentLaunchHooks, type ModelPreferences, type SessionMeta } from "../src/extension/session/SessionRuntime";
import { detectProcessHome } from "../src/extension/pluginSync";
import { readSessionTurns } from "../src/extension/session/forkStore";
import { buildSession } from "./fixtures/cursorStore";
import { groupIds } from "../src/webview/turnGroups";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type * as acp from "@agentclientprotocol/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "fixtures", "fake-agent.mjs");

function makeRuntime(extraEnv: NodeJS.ProcessEnv = {}, approvalPolicy: "ask" | "safe" | "auto" = "ask", modelDefaults: ModelPreferences = {}, mcpServers?: () => Promise<acp.McpServer[]>, launchHooks?: AgentLaunchHooks, store: { lastSession?: string } = {}, beforeConnect?: () => Promise<void>) {
  const messages: ExtensionToWebview[] = [];
  const events: string[] = [];
  const logs: string[] = [];
  let meta: SessionMeta = { titles: {}, hidden: [] };
  const runtime = new SessionRuntime({
    cwd: here,
    workspaceName: "test",
    getLaunchConfig: () => ({ command: process.execPath, args: [FAKE_AGENT], env: { ...process.env, ...extraEnv }, protocolLogging: false }),
    getApprovalConfig: () => ({ policy: approvalPolicy, safeList: DEFAULT_SAFE_LIST }),
    getModelDefaults: () => modelDefaults,
    ...(mcpServers ? { getMcpServers: mcpServers } : {}),
    ...(launchHooks ? { launchHooks } : {}),
    ...(beforeConnect ? { beforeConnect } : {}),
    storage: {
      getLastSessionId: () => store.lastSession,
      setLastSessionId: (id) => (store.lastSession = id),
      getSessionMeta: () => meta,
      setSessionMeta: (m) => (meta = m),
    },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), protocol: () => {}, stderr: () => {} },
    events: {
      message: (m) => messages.push(m),
      permissionRequested: (t) => events.push(`permission:${t}`),
      turnFinished: (r) => events.push(`finished:${r}`),
      questionAsked: (t) => events.push(`question:${t}`),
      agentUnavailable: (e) => events.push(`unavailable:${e}`),
    },
  });
  const launches = () => logs.filter((l) => l.startsWith("Launching Cursor agent")).length;
  return { runtime, messages, events, logs, launches, getLastSession: () => store.lastSession, getMeta: () => meta };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 15));
  }
}

const items = (r: SessionRuntime) => r.model.getItems() as ThreadItem[];
const lastAssistant = (r: SessionRuntime) => [...items(r)].reverse().find((i) => i.type === "assistant") as Extract<ThreadItem, { type: "assistant" }> | undefined;

let active: SessionRuntime[] = [];
afterEach(async () => {
  for (const r of active) await r.dispose();
  active = [];
});

describe("SessionRuntime against a fake ACP agent", () => {
  it("restarts the agent at most once when the post-initialize step changed its config", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "fake-agent-home-")));
    const seen: Array<{ phase: string; home?: string }> = [];
    const hooks: AgentLaunchHooks = {
      beforeSpawn: async () => void seen.push({ phase: "before" }),
      afterInitialize: async (_launch, pid) => {
        const detected = await detectProcessHome(pid);
        seen.push({ phase: "after", ...(detected ? { home: detected } : {}) });
        return true; // Always "changed": must still restart only once.
      },
    };
    const { runtime, launches, logs } = makeRuntime({ HOME: home }, "ask", {}, undefined, hooks);
    active.push(runtime);
    try {
      await runtime.start();
      expect(runtime.state.connection).toBe("ready");
      expect(launches()).toBe(2);
      expect(seen.map((s) => s.phase)).toEqual(["before", "after"]);
      if (process.platform === "darwin" || process.platform === "linux") expect(seen[1]!.home).toBe(home);
      expect(logs.filter((l) => l.startsWith("Restarting the agent"))).toHaveLength(1);
      expect(runtime.model.getItems().filter((i) => i.type === "notice")).toEqual([]);

      // A reconnect is a new connect: one more hook round, again at most one restart.
      await runtime.reconnect();
      expect(runtime.state.connection).toBe("ready");
      expect(launches()).toBe(4);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not restart when the post-initialize step changed nothing", async () => {
    const { runtime, launches } = makeRuntime({}, "ask", {}, undefined, { afterInitialize: async () => false });
    active.push(runtime);
    await runtime.start();
    expect(runtime.state.connection).toBe("ready");
    expect(launches()).toBe(1);
  });

  it("starts a session, streams a turn, and records session metadata", async () => {
    const { runtime, events, getLastSession } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    expect(runtime.state.connection).toBe("ready");
    expect(runtime.state.sessionId).toBeDefined();
    expect(getLastSession()).toBeUndefined();
    expect(runtime.state.modes?.availableModes.map((m) => m.id)).toEqual(["agent", "ask"]);
    expect(runtime.state.models?.currentModelId).toBe("model-a");
    expect(runtime.state.modelOptions.map((o) => o.id)).toEqual(["effort"]);
    await waitFor(() => runtime.state.availableCommands.length > 0);

    await runtime.prompt("hello there", []);
    expect(runtime.state.connection).toBe("ready");
    expect(lastAssistant(runtime)?.text).toBe("Echo: hello there!");
    expect(items(runtime).map((i) => i.type)).toEqual(["user", "thought", "assistant", "turn_end"]);
    expect(runtime.state.title).toBe("Echo hello ther");
    expect(events).toContain("finished:end_turn");
    expect(getLastSession()).toBe(runtime.state.sessionId);
  });

  it("surfaces permission requests and honours the user's decision", async () => {
    const { runtime, events } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    const turn = runtime.prompt("run echo hi", []);
    await waitFor(() => runtime.state.pendingPermissions === 1);
    const tool = items(runtime).find((i) => i.type === "tool") as ToolItem;
    expect(tool.permission?.state).toBe("pending");
    expect(tool.permission?.options.map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
    expect(events.some((e) => e.startsWith("permission:"))).toBe(true);
    runtime.respondToPermission(tool.permission!.requestId, "allow-once");
    await turn;
    const done = items(runtime).find((i) => i.type === "tool") as ToolItem;
    expect(done.status).toBe("completed");
    expect(done.output).toBe("hello\n");
    expect(done.exitCode).toBe(0);
    expect(done.permission?.state).toBe("resolved");
    expect(runtime.state.pendingPermissions).toBe(0);
  });

  it("rejects a tool when the user declines", async () => {
    const { runtime } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    const turn = runtime.prompt("run echo hi", []);
    await waitFor(() => runtime.state.pendingPermissions === 1);
    const tool = items(runtime).find((i) => i.type === "tool") as ToolItem;
    runtime.respondToPermission(tool.permission!.requestId, "reject-once");
    await turn;
    expect((items(runtime).find((i) => i.type === "tool") as ToolItem).status).toBe("failed");
    expect(lastAssistant(runtime)?.text).toBe("Okay, I won't run that.");
  });

  it("cancels a running turn and answers pending permissions with cancelled", async () => {
    const { runtime } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    const turn = runtime.prompt("run echo hi", []);
    await waitFor(() => runtime.state.pendingPermissions === 1);
    await runtime.cancel();
    await turn;
    expect(runtime.state.connection).toBe("ready");
    const end = items(runtime).find((i) => i.type === "turn_end") as Extract<ThreadItem, { type: "turn_end" }>;
    expect(end.stopReason).toBe("cancelled");
    expect((items(runtime).find((i) => i.type === "tool") as ToolItem).permission?.state).toBe("cancelled");
  });

  it("cancels a long-running prompt via session/cancel", async () => {
    const { runtime } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    const turn = runtime.prompt("sleep 20000", []);
    await waitFor(() => runtime.state.connection === "running");
    await waitFor(() => lastAssistant(runtime) !== undefined);
    const started = Date.now();
    await runtime.cancel();
    await turn;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(runtime.state.connection).toBe("ready");
  });

  it("queues a prompt sent while a turn runs and sends it when the turn ends", async () => {
    const { runtime } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    const turn = runtime.prompt("sleep 300", []);
    await waitFor(() => runtime.state.connection === "running");
    await runtime.prompt("hello after", []);
    await runtime.prompt("and then this", []);
    expect(runtime.state.queued).toEqual([
      { text: "hello after", attachmentCount: 0 },
      { text: "and then this", attachmentCount: 0 },
    ]);
    runtime.moveQueued(1, 0);
    expect(runtime.state.queued?.map((q) => q.text)).toEqual(["and then this", "hello after"]);
    runtime.moveQueued(0, 1);
    await turn;
    await waitFor(() => runtime.state.queued === undefined && runtime.state.connection === "ready");
    const users = items(runtime).filter((i) => i.type === "user") as Array<Extract<ThreadItem, { type: "user" }>>;
    expect(users.map((u) => u.text)).toEqual(["sleep 300", "hello after", "and then this"]);
  });

  it("keeps a queued prompt when the user stops the turn, and sends it on demand", async () => {
    const { runtime } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    const turn = runtime.prompt("sleep 20000", []);
    await waitFor(() => runtime.state.connection === "running");
    await runtime.prompt("later", []);
    await runtime.cancel();
    await turn;
    expect(runtime.state.connection).toBe("ready");
    expect(runtime.state.queued?.[0]?.text).toBe("later");
    await runtime.sendQueuedNow(0);
    await waitFor(() => runtime.state.connection === "ready" && runtime.state.queued === undefined);
    const users = items(runtime).filter((i) => i.type === "user") as Array<Extract<ThreadItem, { type: "user" }>>;
    expect(users.map((u) => u.text)).toEqual(["sleep 20000", "later"]);
  });

  it("send-now picks the chosen queued message and the rest follow in order", async () => {
    const { runtime } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    const turn = runtime.prompt("sleep 20000", []);
    await waitFor(() => runtime.state.connection === "running");
    await runtime.prompt("first queued", []);
    await runtime.prompt("second queued", []);
    await runtime.prompt("third queued", []);
    await runtime.sendQueuedNow(1);
    await turn.catch(() => undefined);
    await waitFor(() => runtime.state.queued === undefined && runtime.state.connection === "ready", 20_000);
    const users = items(runtime).filter((i) => i.type === "user") as Array<Extract<ThreadItem, { type: "user" }>>;
    expect(users.map((u) => u.text)).toEqual(["sleep 20000", "second queued", "first queued", "third queued"]);
  });

  it("interrupt mode cancels the running turn and sends immediately", async () => {
    const { runtime } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    const turn = runtime.prompt("sleep 20000", []);
    await waitFor(() => runtime.state.connection === "running");
    const started = Date.now();
    await runtime.prompt("now please", [], "interrupt");
    await turn.catch(() => undefined);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(runtime.state.queued).toBeUndefined();
    const users = items(runtime).filter((i) => i.type === "user") as Array<Extract<ThreadItem, { type: "user" }>>;
    expect(users.map((u) => u.text)).toEqual(["sleep 20000", "now please"]);
    expect(runtime.state.connection).toBe("ready");
  });

  it("applies local renames and hides sessions in the history list", async () => {
    const { runtime } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    await runtime.prompt("hello", []);
    const id = runtime.state.sessionId!;
    runtime.renameSession(id, "My rename");
    expect(runtime.state.title).toBe("My rename");
    const listed = await runtime.listSessions();
    expect(listed.find((s) => s.sessionId === id)?.title).toBe("My rename");
    runtime.renameSession(id, "");
    expect(runtime.state.title).not.toBe("My rename");
    runtime.hideSession(id);
    expect((await runtime.listSessions()).some((s) => s.sessionId === id)).toBe(false);
    // The history tab lists hidden sessions flagged, and can unhide them.
    expect((await runtime.listSessions({ includeHidden: true })).find((s) => s.sessionId === id)?.hidden).toBe(true);
    runtime.setSessionsHidden([id], false);
    const shown = (await runtime.listSessions()).find((s) => s.sessionId === id);
    expect(shown).toBeDefined();
    expect(shown?.hidden).toBeUndefined();
    runtime.setSessionsHidden([id], true);
    expect((await runtime.listSessions()).some((s) => s.sessionId === id)).toBe(false);
  });

  it("safe-list policy approves read-only commands silently and asks for the rest", async () => {
    const { runtime } = makeRuntime({}, "safe");
    active.push(runtime);
    await runtime.start();
    await runtime.prompt("run ls -la", []);
    let tool = items(runtime).find((i) => i.type === "tool") as Extract<ThreadItem, { type: "tool" }>;
    expect(tool.permission?.state).toBe("resolved");
    expect(tool.permission?.resolution).toBe("auto");
    const risky = runtime.prompt("run rm -rf build", []);
    await waitFor(() => runtime.state.pendingPermissions === 1);
    tool = items(runtime).filter((i) => i.type === "tool").at(-1) as Extract<ThreadItem, { type: "tool" }>;
    expect(tool.permission?.state).toBe("pending");
    // "Allow for session" remembers the command name.
    runtime.respondToPermission(tool.permission!.requestId, tool.permission!.options[0]!.optionId, "session");
    await risky;
    expect(runtime.state.sessionAllowed).toEqual(["rm"]);
    await runtime.prompt("run rm -rf dist", []);
    tool = items(runtime).filter((i) => i.type === "tool").at(-1) as Extract<ThreadItem, { type: "tool" }>;
    expect(tool.permission?.resolution).toBe("session");
  });

  it("forwards MCP servers with session/new and session/load, and survives a failing provider", async () => {
    let calls = 0;
    const provider = async (): Promise<acp.McpServer[]> => {
      calls++;
      if (calls === 3) throw new Error("boom");
      return [{ name: "echoprobe", command: "node", args: ["server.mjs"], env: [] }, { type: "http", name: "jira", url: "https://mcp.example/", headers: [] }];
    };
    const { runtime, logs } = makeRuntime({}, "ask", {}, provider);
    active.push(runtime);
    await runtime.start();
    expect(runtime.forwardedMcpServers).toEqual(["echoprobe", "jira"]);
    await runtime.prompt("mcp list", []);
    expect(lastAssistant(runtime)?.text).toBe("MCP: echoprobe (node server.mjs); jira (https://mcp.example/)");
    expect(logs.some((l) => l.includes("Forwarding MCP servers: echoprobe, jira"))).toBe(true);
    // Resume re-sends them (the CLI takes mcpServers on session/load too).
    const id = runtime.state.sessionId!;
    await runtime.loadSession(id);
    expect(calls).toBe(2);
    await runtime.prompt("mcp list", []);
    expect(lastAssistant(runtime)?.text).toContain("echoprobe");
    // A broken config must not stop sessions from being created.
    await runtime.newSession();
    expect(calls).toBe(3);
    expect(runtime.state.connection).toBe("ready");
    expect(runtime.forwardedMcpServers).toEqual([]);
    expect(logs.some((l) => l.includes("Could not read MCP config: boom"))).toBe(true);
  });

  it("matches MCP tool calls against the safe list and remembers them for the session", async () => {
    const { runtime } = makeRuntime({}, "safe");
    active.push(runtime);
    await runtime.start();
    // A read-only tool name matches the default Mcp(...) safe-list entry even though Cursor sends no reason text.
    await runtime.prompt("mcp call plugin-atlassian-atlassian searchJiraIssuesUsingJql", []);
    let tool = items(runtime).filter((i) => i.type === "tool").at(-1) as ToolItem;
    expect(tool.mcpPattern).toBe("Mcp(plugin-atlassian-atlassian:searchJiraIssuesUsingJql)");
    expect(tool.permission?.state).toBe("resolved");
    expect(tool.permission?.resolution).toBe("auto");
    expect(tool.permission?.reason).toBeUndefined();
    expect(tool.inputText).toContain('"text": "hi"');
    expect(tool.output).toBe("ECHO:hi");
    // A writing tool asks; "Allow for session" keys on Cursor's Mcp(server:tool) pattern.
    const write = runtime.prompt("mcp call plugin-atlassian-atlassian createJiraIssue", []);
    await waitFor(() => runtime.state.pendingPermissions === 1);
    tool = items(runtime).filter((i) => i.type === "tool").at(-1) as ToolItem;
    expect(tool.permission?.state).toBe("pending");
    runtime.respondToPermission(tool.permission!.requestId, tool.permission!.options[0]!.optionId, "session");
    await write;
    expect(runtime.state.sessionAllowed).toEqual(["Mcp(plugin-atlassian-atlassian:createJiraIssue)"]);
    await runtime.prompt("mcp call plugin-atlassian-atlassian createJiraIssue", []);
    tool = items(runtime).filter((i) => i.type === "tool").at(-1) as ToolItem;
    expect(tool.permission?.resolution).toBe("session");
  });

  it("auto policy approves everything and switching policy resolves a waiting request", async () => {
    const { runtime } = makeRuntime({}, "ask");
    active.push(runtime);
    await runtime.start();
    const turn = runtime.prompt("run npm test", []);
    await waitFor(() => runtime.state.pendingPermissions === 1);
    runtime.setApprovalPolicy("auto");
    await turn;
    const tool = items(runtime).find((i) => i.type === "tool") as Extract<ThreadItem, { type: "tool" }>;
    expect(tool.permission?.resolution).toBe("auto");
    expect(runtime.state.approvalPolicy).toBe("auto");
  });

  it("renders edits as diffs and tracks changed files", async () => {
    const { runtime } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    const captured: string[] = [];
    runtime.model.setDiffListener((_id, path, oldText, newText) => captured.push(`${path}|${oldText}|${newText}`));
    await runtime.prompt(`edit ${join(here, "x.txt")}`, []);
    const tool = items(runtime).find((i) => i.type === "tool") as ToolItem;
    expect(tool.kind).toBe("edit");
    expect(tool.diffs[0]?.displayPath).toBe("x.txt");
    expect(tool.diffs[0]?.additions).toBe(2);
    expect(tool.diffs[0]?.deletions).toBe(1);
    expect(runtime.state.changedFiles[0]?.displayPath).toBe("x.txt");
    expect(captured[0]).toBe(`${join(here, "x.txt")}|a\nb\nc\n|a\nB\nc\nd\n`);
  });

  it("answers cursor/ask_question and cursor/create_plan, and applies todos", async () => {
    const { runtime, events } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    const ask = runtime.prompt("ask", []);
    await waitFor(() => items(runtime).some((i) => i.type === "question"));
    const question = items(runtime).find((i) => i.type === "question") as Extract<ThreadItem, { type: "question" }>;
    expect(question.questions[0]?.options.map((o) => o.id)).toEqual(["x", "y"]);
    runtime.respondToQuestion(question.requestId, [{ questionId: "q", selectedOptionIds: ["y"] }]);
    await ask;
    expect(lastAssistant(runtime)?.text).toContain('"answered"');
    expect((items(runtime).find((i) => i.type === "question") as Extract<ThreadItem, { type: "question" }>).state).toBe("answered");
    expect(events.some((e) => e.startsWith("question:"))).toBe(true);

    const plan = runtime.prompt("plan", []);
    await waitFor(() => items(runtime).some((i) => i.type === "plan_proposal"));
    const proposal = items(runtime).find((i) => i.type === "plan_proposal") as Extract<ThreadItem, { type: "plan_proposal" }>;
    expect(proposal.name).toBe("My plan");
    runtime.respondToPlan(proposal.requestId, true);
    await plan;
    expect(lastAssistant(runtime)?.text).toBe("Plan accepted");
    const todos = items(runtime).find((i) => i.type === "todos") as Extract<ThreadItem, { type: "todos" }>;
    expect(todos.todos[0]?.status).toBe("completed");
  });

  it("resumes a session, marking replayed history as history", async () => {
    const { runtime } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    await runtime.prompt("first", []);
    const sessionId = runtime.state.sessionId!;
    const sessions = await runtime.listSessions();
    expect(sessions.map((s) => s.sessionId)).toContain(sessionId);

    await runtime.loadSession(sessionId);
    expect(runtime.state.connection).toBe("ready");
    const replayed = items(runtime);
    expect(replayed.map((i) => i.type)).toEqual(["user", "assistant", "divider"]);
    expect(replayed[0]?.replay).toBe(true);
    expect((replayed[1] as Extract<ThreadItem, { type: "assistant" }>).streaming).toBe(false);
    expect((replayed[1] as Extract<ThreadItem, { type: "assistant" }>).text).toBe("Echo: first!");
  });

  it("forks after a turn: opens a copy that ends with that reply, leaving the source as it is", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "fork-config-"));
    const { runtime, getMeta, getLastSession } = makeRuntime({ CURSOR_CONFIG_DIR: configDir });
    active.push(runtime);
    try {
      await runtime.start();
      await expect(runtime.forkAfterTurn("user-1")).rejects.toThrow(/not been saved/);
      const prompts = ["one", "two", "three"];
      for (const text of prompts) await runtime.prompt(text, []);
      await runtime.setModel("model-b");
      const source = runtime.state.sessionId!;
      // What Cursor itself would have on disk for this session.
      buildSession(join(configDir, "acp-sessions"), source, prompts, "Numbers");

      await expect(runtime.forkAfterTurn("no-such-item")).rejects.toThrow(/no longer in the transcript/);
      const second = items(runtime).filter((i) => i.type === "user")[1]!;
      await runtime.forkAfterTurn(second.id);

      const forkId = runtime.state.sessionId!;
      expect(forkId).not.toBe(source);
      expect(runtime.state.connection).toBe("ready");
      expect(getLastSession()).toBe(forkId);
      const shown = items(runtime);
      expect(shown.filter((i) => i.type === "user").map((i) => (i as Extract<ThreadItem, { type: "user" }>).text)).toEqual(["one", "two"]);
      expect(lastAssistant(runtime)?.text).toBe("Echo: two!");
      expect(shown[shown.length - 1]).toMatchObject({ type: "divider", text: "Forked from “Echo three”" });
      expect(shown.some((i) => i.type === "notice")).toBe(false);
      // The fork keeps the source's model choice; the source keeps all of its history.
      expect(getMeta().models?.[forkId]?.modelId).toBe("model-b");
      expect(runtime.state.models?.currentModelId).toBe("model-b");
      expect(readSessionTurns(join(configDir, "acp-sessions"), source).map((t) => t.text)).toEqual(prompts);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("every finished turn has a fork point, live and after a resume: fork after the first and after the fifth", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "fork-config-"));
    const { runtime } = makeRuntime({ CURSOR_CONFIG_DIR: configDir });
    active.push(runtime);
    const users = () => items(runtime).filter((i): i is Extract<ThreadItem, { type: "user" }> => i.type === "user");
    // The fork buttons the transcript shows, in order: the user message each one forks after.
    const forkButtons = () => {
      const shown = items(runtime);
      return groupIds(
        shown.map((i) => i.id),
        new Map(shown.map((i) => [i.id, i])),
      ).flatMap((g) => (g.forkFrom ? [g.forkFrom] : []));
    };
    try {
      await runtime.start();
      const prompts = ["p1", "p2", "p3", "p4", "p5"];
      for (const text of prompts) await runtime.prompt(text, []);
      const source = runtime.state.sessionId!;
      buildSession(join(configDir, "acp-sessions"), source, prompts);
      expect(forkButtons()).toEqual(users().map((u) => u.id));

      await runtime.forkAfterTurn(forkButtons()[0]!);
      expect(users().map((u) => u.text)).toEqual(["p1"]);
      expect(forkButtons()).toHaveLength(1);

      // Back in the source, its replayed history offers all five again.
      await runtime.loadSession(source);
      expect(users().map((u) => u.text)).toEqual(prompts);
      expect(forkButtons()).toEqual(users().map((u) => u.id));
      await runtime.forkAfterTurn(forkButtons()[4]!);
      expect(runtime.state.sessionId).not.toBe(source);
      expect(users().map((u) => u.text)).toEqual(prompts);
      expect(lastAssistant(runtime)?.text).toBe("Echo: p5!");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("falls back to a new session when the stored session no longer exists", async () => {
    const { runtime, getLastSession } = makeRuntime();
    active.push(runtime);
    await runtime.start("does-not-exist");
    expect(runtime.state.connection).toBe("ready");
    expect(runtime.state.sessionId).toBeDefined();
    expect(runtime.state.sessionId).not.toBe("does-not-exist");
    const notice = items(runtime).find((i) => i.type === "notice") as Extract<ThreadItem, { type: "notice" }>;
    expect(notice.level).toBe("info");
    expect(notice.detail).toContain("Session not found");
    // Nothing remembered until a prompt is sent (Cursor does not persist empty sessions).
    expect(getLastSession()).toBeUndefined();
    await runtime.prompt("hello", []);
    expect(getLastSession()).toBe(runtime.state.sessionId);
  });

  it("recovers when the agent process dies mid-turn", async () => {
    const { runtime } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    await runtime.prompt("crash", []);
    await waitFor(() => runtime.state.connection === "disconnected");
    const notice = items(runtime).find((i) => i.type === "notice") as Extract<ThreadItem, { type: "notice" }>;
    expect(notice.text).toContain("exited with code 3");
    expect(notice.actions).toContain("reconnect");
    // Reconnect spawns a new process; the old session id is gone in the fake agent, so a new one is created.
    await runtime.reconnect();
    expect(["ready", "error"]).toContain(runtime.state.connection);
  });

  it("shows a useful error when the executable cannot be found", async () => {
    const { runtime, events } = makeRuntime();
    active.push(runtime);
    (runtime as unknown as { options: { getLaunchConfig: () => unknown } }).options.getLaunchConfig = () => ({
      command: "/definitely/not/here/agent",
      args: [],
      env: process.env,
      protocolLogging: false,
    });
    await runtime.start();
    expect(runtime.state.connection).toBe("error");
    // A fresh view shows the setup card (driven by the agentUnavailable event) instead of a notice.
    expect(items(runtime).some((i) => i.type === "notice")).toBe(false);
    expect(runtime.state.lastError).toContain("not found");
    expect(events.some((e) => e.startsWith("unavailable:") && e.includes("not found"))).toBe(true);
  });

  it("reports authentication failures with a login hint", async () => {
    const { runtime, events } = makeRuntime({ FAKE_AGENT_AUTH_FAIL: "1" });
    active.push(runtime);
    await runtime.start();
    expect(runtime.state.connection).toBe("error");
    expect(runtime.state.lastError).toContain("not logged in");
    expect(runtime.state.authRequired).toBe(true);
    expect(events.some((e) => e.startsWith("unavailable:") && e.includes("not logged in"))).toBe(true);
    // Once the transcript has content, failures are reported inline as notices.
    await runtime.prompt("hello", []);
    const notice = items(runtime).find((i) => i.type === "notice") as Extract<ThreadItem, { type: "notice" }> | undefined;
    expect(notice?.text ?? runtime.state.lastError).toContain("not logged in");
  });

  it("switches mode and model, remembering the choice per session", async () => {
    const { runtime, getMeta } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    await runtime.setMode("ask");
    expect(runtime.state.modes?.currentModeId).toBe("ask");
    await runtime.setModel("model-b");
    expect(runtime.state.models?.currentModelId).toBe("model-b");
    const id = runtime.state.sessionId!;
    expect(getMeta().models?.[id]?.modelId).toBe("model-b");
    expect(runtime.state.modelOptions).toEqual([]);
    await runtime.setModel("model-a");
    await runtime.setConfigOption("effort", "low");
    expect(runtime.state.modelOptions[0]?.currentValue).toBe("low");
    expect(getMeta().models?.[id]).toEqual({ modelId: "model-a", options: { effort: "low" } });
  });

  it("applies the settings defaults to new sessions and a session's own choice on resume", async () => {
    const { runtime } = makeRuntime({}, "ask", { modelId: "model-a", options: { effort: "low" } });
    active.push(runtime);
    await runtime.start();
    expect(runtime.state.models?.currentModelId).toBe("model-a");
    expect(runtime.state.modelOptions[0]?.currentValue).toBe("low");
    await runtime.prompt("hello", []);
    const first = runtime.state.sessionId!;
    await runtime.setModel("model-b");
    await runtime.newSession();
    expect(runtime.state.models?.currentModelId).toBe("model-a");
    await runtime.loadSession(first);
    expect(runtime.state.models?.currentModelId).toBe("model-b");
  });

  it("publishes the changed-files summary once per finished edit, not per update", async () => {
    const { runtime, messages } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    await runtime.prompt(`editrepeat ${join(here, "x.txt")}`, []);
    const tool = items(runtime).find((i) => i.type === "tool") as ToolItem;
    expect(tool.status).toBe("completed");
    expect(runtime.state.changedFiles).toEqual([{ path: join(here, "x.txt"), displayPath: "x.txt", additions: 2, deletions: 1 }]);
    const withChanges = messages.filter((m) => m.type === "session" && m.session.changedFiles.length > 0);
    expect(withChanges.length).toBeGreaterThan(0);
    expect(withChanges.length).toBeLessThanOrEqual(3);
  });

  it("prompt errors from the agent become notices, not crashes", async () => {
    const { runtime } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    await runtime.prompt("fail", []);
    expect(runtime.state.connection).toBe("ready");
    const notice = items(runtime).find((i) => i.type === "notice") as Extract<ThreadItem, { type: "notice" }>;
    expect(notice.text).toContain("Something went wrong");
  });
});

describe("Resuming the last session in a new window", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** One window's session: prompts once in a new session and closes, leaving the id in `store`. */
  async function previousWindow(env: NodeJS.ProcessEnv, store: { lastSession?: string }): Promise<string> {
    const { runtime } = makeRuntime(env, "ask", {}, undefined, undefined, store);
    await runtime.start(store.lastSession);
    await runtime.prompt("first", []);
    const id = runtime.state.sessionId!;
    await runtime.dispose();
    return id;
  }

  function storeEnv(): NodeJS.ProcessEnv {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "fake-agent-store-")));
    return { FAKE_AGENT_STORE: join(dir, "sessions.json") };
  }

  it("resumes the session from the previous window in a fresh agent process", async () => {
    const env = storeEnv();
    const store: { lastSession?: string } = {};
    const s1 = await previousWindow(env, store);
    expect(store.lastSession).toBe(s1);

    const { runtime, logs } = makeRuntime(env, "ask", {}, undefined, undefined, store);
    active.push(runtime);
    await runtime.start(store.lastSession);
    expect(runtime.state.sessionId).toBe(s1);
    expect(items(runtime).map((i) => i.type)).toEqual(["user", "assistant", "divider"]);
    expect(logs).toContain(`Resumed session ${s1}`);
  });

  it("still resumes when the agent is restarted once after initialize", async () => {
    const env = storeEnv();
    const store: { lastSession?: string } = {};
    const s1 = await previousWindow(env, store);

    const { runtime, launches, logs } = makeRuntime(env, "ask", {}, undefined, { afterInitialize: async () => true }, store);
    active.push(runtime);
    await runtime.start(store.lastSession);
    expect(launches()).toBe(2);
    expect(logs.some((l) => l.startsWith("Restarting the agent"))).toBe(true);
    expect(runtime.state.sessionId).toBe(s1);
    expect(items(runtime).map((i) => i.type)).toEqual(["user", "assistant", "divider"]);
    expect(logs.some((l) => l.startsWith("New session"))).toBe(false);
    expect(store.lastSession).toBe(s1);
  });

  it("resumes when the history list connects the agent first (restart included)", async () => {
    const env = storeEnv();
    const store: { lastSession?: string } = {};
    const s1 = await previousWindow(env, store);

    const { runtime, launches, logs } = makeRuntime(env, "ask", {}, undefined, { afterInitialize: async () => true }, store);
    active.push(runtime);
    // The chat's history list asks for sessions as soon as the webview is up, before the start.
    const list = runtime.listSessions();
    const start = runtime.start(store.lastSession);
    const [sessions] = await Promise.all([list, start]);
    expect(sessions.map((s) => s.sessionId)).toContain(s1);
    expect(launches()).toBe(2);
    expect(runtime.state.sessionId).toBe(s1);
    expect(logs.some((l) => l.startsWith("New session"))).toBe(false);
  });

  it("a resume requested while another start is in flight wins over it", async () => {
    const env = { ...storeEnv(), FAKE_AGENT_NEW_DELAY_MS: "150" };
    const store: { lastSession?: string } = {};
    const s1 = await previousWindow(env, store);

    const { runtime } = makeRuntime(env, "ask", {}, undefined, { afterInitialize: async () => true }, store);
    active.push(runtime);
    const fresh = runtime.start();
    await waitFor(() => runtime.state.connection === "starting");
    await Promise.all([fresh, runtime.start(store.lastSession)]);
    expect(runtime.state.connection).toBe("ready");
    expect(runtime.state.sessionId).toBe(s1);
    expect(items(runtime).map((i) => i.type)).toEqual(["user", "assistant", "divider"]);
  });

  it("a resume that fails keeps the stored session, so a later window can still open it", async () => {
    const env = storeEnv();
    const store: { lastSession?: string } = {};
    const s1 = await previousWindow(env, store);

    // Evidence from the logs: one window ran a differently configured agent that did not know the
    // session ("Could not resume … Invalid params"); every later window then started a new session.
    const other = makeRuntime({ FAKE_AGENT_STORE: join(dir!, "other-profile.json") }, "ask", {}, undefined, undefined, store);
    await other.runtime.start(store.lastSession);
    expect(other.runtime.state.sessionId).not.toBe(s1);
    expect(items(other.runtime).some((i) => i.type === "notice")).toBe(true);
    await other.runtime.dispose();
    expect(store.lastSession).toBe(s1);

    const next = makeRuntime(env, "ask", {}, undefined, undefined, store);
    active.push(next.runtime);
    await next.runtime.start(store.lastSession);
    expect(next.runtime.state.sessionId).toBe(s1);
  });

  it("the startup resume is queued at once and later requests line up behind it", async () => {
    const env = storeEnv();
    const store: { lastSession?: string } = {};
    const s1 = await previousWindow(env, store);

    // The login-shell PATH lookup gates every launch; requests made meanwhile must keep their order.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { runtime, launches } = makeRuntime(env, "ask", {}, undefined, undefined, store, () => gate);
    active.push(runtime);
    const start = runtime.start(store.lastSession);
    const list = runtime.listSessions();
    const turn = runtime.prompt("again", []);
    await new Promise((r) => setTimeout(r, 50));
    expect(launches()).toBe(0);
    open();
    await Promise.all([start, list, turn]);
    expect(launches()).toBe(1);
    expect(runtime.state.sessionId).toBe(s1);
    expect(lastAssistant(runtime)?.text).toBe("Echo: again!");

    // A new session asked for while the startup resume is still waiting wins over it.
    await runtime.dispose();
    let open2!: () => void;
    const gate2 = new Promise<void>((resolve) => (open2 = resolve));
    const second = makeRuntime(env, "ask", {}, undefined, undefined, store, () => gate2);
    active.push(second.runtime);
    const resume = second.runtime.start(store.lastSession);
    const fresh = second.runtime.newSession();
    open2();
    await Promise.all([resume, fresh]);
    expect(second.runtime.state.sessionId).not.toBe(s1);
    expect(items(second.runtime)).toEqual([]);
  });

  it("reconnecting a session that never got a prompt starts a new one instead of failing to load it", async () => {
    const { runtime, logs } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    const empty = runtime.state.sessionId;
    await runtime.reconnect();
    expect(runtime.state.connection).toBe("ready");
    expect(runtime.state.sessionId).not.toBe(empty);
    expect(items(runtime).some((i) => i.type === "notice")).toBe(false);
    expect(logs.some((l) => l.startsWith("Could not resume"))).toBe(false);
  });

  it("remembers a session resumed from history, so the next window reopens it", async () => {
    const env = storeEnv();
    const store: { lastSession?: string } = {};
    const s1 = await previousWindow(env, store);

    const { runtime } = makeRuntime(env, "ask", {}, undefined, undefined, store);
    active.push(runtime);
    await runtime.start(store.lastSession);
    await runtime.newSession();
    await runtime.prompt("second", []);
    const s2 = runtime.state.sessionId!;
    expect(store.lastSession).toBe(s2);
    await runtime.loadSession(s1);
    expect(store.lastSession).toBe(s1);
    await runtime.dispose();

    const next = makeRuntime(env, "ask", {}, undefined, undefined, store);
    active.push(next.runtime);
    await next.runtime.start(store.lastSession);
    expect(next.runtime.state.sessionId).toBe(s1);
  });
});

describe("SessionRuntime lifecycle races", () => {
  it("reconnects while a prompt is running and ends up in a usable session", async () => {
    const { runtime, launches } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    const turn = runtime.prompt("sleep 20000", []);
    await waitFor(() => runtime.state.connection === "running");
    await runtime.reconnect();
    await turn;
    expect(runtime.state.connection).toBe("ready");
    expect(launches()).toBe(2);
    // The old (unpersisted) session is gone in the fake agent, so a fresh one is created; the turn is not left open.
    expect(runtime.state.turnStartedAt).toBeUndefined();
    await runtime.prompt("hello", []);
    expect(lastAssistant(runtime)?.text).toBe("Echo: hello!");
  });

  it("reconnect while starting does not leave a stale start in charge", async () => {
    const { runtime, launches } = makeRuntime({ FAKE_AGENT_NEW_DELAY_MS: "300" });
    active.push(runtime);
    const first = runtime.start();
    await waitFor(() => runtime.state.connection === "starting");
    await new Promise((r) => setTimeout(r, 50));
    const again = runtime.reconnect();
    await Promise.all([first, again]);
    expect(runtime.state.connection).toBe("ready");
    expect(runtime.state.sessionId).toBeDefined();
    expect(launches()).toBe(2);
    // The superseded start must not have reported an error.
    expect(items(runtime).some((i) => i.type === "notice")).toBe(false);
  });

  it("loads the last requested session when loadSession is called twice quickly", async () => {
    const { runtime, messages, launches } = makeRuntime({ FAKE_AGENT_LOAD_DELAY_MS: "200" });
    active.push(runtime);
    await runtime.start();
    await runtime.prompt("first", []);
    const s1 = runtime.state.sessionId!;
    await runtime.newSession();
    await runtime.prompt("second", []);
    const s2 = runtime.state.sessionId!;

    const resets = () => messages.filter((m) => m.type === "items.reset").length;
    const before = resets();
    const a = runtime.loadSession(s1);
    const b = runtime.loadSession(s2);
    const c = runtime.loadSession(s2);
    await Promise.all([a, b, c]);
    expect(runtime.state.connection).toBe("ready");
    expect(runtime.state.sessionId).toBe(s2);
    expect(lastAssistant(runtime)?.text).toBe("Echo: second!");
    // First load ran, the two identical follow-ups were merged into one queued load.
    expect(resets() - before).toBe(2);
    expect(launches()).toBe(1);

    // Same target while already loading: shares the in-flight load.
    const d = runtime.loadSession(s1);
    const e = runtime.loadSession(s1);
    await Promise.all([d, e]);
    expect(runtime.state.sessionId).toBe(s1);
    expect(lastAssistant(runtime)?.text).toBe("Echo: first!");
  });

  it("newSession while a start is in flight waits for it and then creates a fresh session once", async () => {
    const { runtime, launches, messages } = makeRuntime({ FAKE_AGENT_NEW_DELAY_MS: "150", FAKE_AGENT_LOAD_DELAY_MS: "150" });
    active.push(runtime);
    const resets = () => messages.filter((m) => m.type === "items.reset").length;
    // Two requests for a fresh session while one is already being created share that start.
    const starting = runtime.start();
    await waitFor(() => runtime.state.connection === "starting");
    await Promise.all([starting, runtime.newSession(), runtime.newSession()]);
    expect(runtime.state.connection).toBe("ready");
    expect(resets()).toBe(1);
    await runtime.prompt("first", []);
    const s1 = runtime.state.sessionId!;

    // A fresh session requested while a resume is replaying runs after it, once, and wins.
    const before = resets();
    const load = runtime.loadSession(s1);
    await waitFor(() => runtime.state.connection === "loading");
    await Promise.all([load, runtime.newSession(), runtime.newSession()]);
    expect(runtime.state.connection).toBe("ready");
    expect(runtime.state.sessionId).not.toBe(s1);
    expect(items(runtime)).toEqual([]);
    expect(resets() - before).toBe(2);
    expect(launches()).toBe(1);
    expect(items(runtime).some((i) => i.type === "notice")).toBe(false);
  });

  it("prompting while a session is being resumed waits for the replay instead of opening a new session", async () => {
    const { runtime, launches } = makeRuntime({ FAKE_AGENT_LOAD_DELAY_MS: "200" });
    active.push(runtime);
    await runtime.start();
    await runtime.prompt("first", []);
    const s1 = runtime.state.sessionId!;
    await runtime.newSession();

    const load = runtime.loadSession(s1);
    await waitFor(() => runtime.state.connection === "loading");
    const turn = runtime.prompt("hello", []);
    await Promise.all([load, turn]);
    expect(runtime.state.sessionId).toBe(s1);
    expect(items(runtime).map((i) => i.type)).toEqual(["user", "assistant", "divider", "user", "thought", "assistant", "turn_end"]);
    expect(lastAssistant(runtime)?.text).toBe("Echo: hello!");
    expect(launches()).toBe(1);
  });

  it("cancels a pending question and reports disconnected exactly once when the agent dies mid-turn", async () => {
    const { runtime, messages, events } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    await runtime.prompt("askcrash", []);
    await waitFor(() => runtime.state.connection === "disconnected");
    await new Promise((r) => setTimeout(r, 50));
    const question = items(runtime).find((i) => i.type === "question") as Extract<ThreadItem, { type: "question" }>;
    expect(question.state).toBe("cancelled");
    const end = items(runtime).find((i) => i.type === "turn_end") as Extract<ThreadItem, { type: "turn_end" }>;
    expect(end.stopReason).toBe("error");
    const notices = items(runtime).filter((i) => i.type === "notice") as Extract<ThreadItem, { type: "notice" }>[];
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain("exited with code 4");
    expect(messages.filter((m) => m.type === "session" && m.session.connection === "disconnected")).toHaveLength(1);
    expect(events).toContain("finished:error");
    expect(runtime.state.pendingPermissions).toBe(0);
  });

  it("reports a crash during startup once, with the agent's stderr", async () => {
    const { runtime, events, messages } = makeRuntime({ FAKE_AGENT_CRASH_ON_INIT: "1" });
    active.push(runtime);
    await runtime.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(runtime.state.connection).toBe("error");
    expect(runtime.state.lastError).toContain("exited with code 2");
    expect(items(runtime).some((i) => i.type === "notice")).toBe(false);
    expect(events.filter((e) => e.startsWith("unavailable:"))).toHaveLength(1);
    expect(messages.filter((m) => m.type === "session" && m.session.connection === "disconnected")).toHaveLength(0);
    // Once the transcript has content the same failure becomes a single inline notice.
    runtime.model.addNotice("info", "existing content", undefined, []);
    await runtime.prompt("hello", []);
    const notices = items(runtime).filter((i) => i.type === "notice") as Extract<ThreadItem, { type: "notice" }>[];
    expect(notices).toHaveLength(2);
    expect(notices[1]!.detail).toContain("refusing to start");
  });

  it("dispose during startup does not leave the agent running", async () => {
    const { runtime, launches } = makeRuntime({ FAKE_AGENT_NEW_DELAY_MS: "300" });
    const started = runtime.start();
    await waitFor(() => runtime.state.connection === "starting");
    await runtime.dispose();
    await started;
    expect(launches()).toBe(1);
    expect(runtime.state.connection).not.toBe("ready");
    expect(runtime.hasSession).toBe(false);
  });
});
