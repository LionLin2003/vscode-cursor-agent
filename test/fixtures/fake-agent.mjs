#!/usr/bin/env node
/**
 * A tiny fake ACP agent that mimics the parts of Cursor's `agent acp` the
 * extension relies on. Driven by the prompt text:
 *   "echo <text>"      → streams thought + message chunks
 *   "run <cmd>"        → tool_call execute, requests permission, completes
 *   "edit <path>"      → tool_call edit with a diff
 *   "ask"              → cursor/ask_question request
 *   "plan"             → cursor/create_plan request + cursor/update_todos
 *   "sleep <ms>"       → waits (cancellable) before answering
 *   "crash"            → exits the process with code 3
 *   "askcrash"         → asks a question, then exits with code 4 while it is pending
 *   "editrepeat <path>"→ edit whose identical diff content is resent in several updates
 *   "fail"             → responds with a JSON-RPC error
 *
 * Environment knobs:
 *   FAKE_AGENT_AUTH_FAIL=1        authenticate fails
 *   FAKE_AGENT_CRASH_ON_INIT=1    prints to stderr and exits with code 2 on initialize
 *   FAKE_AGENT_LOAD_DELAY_MS=n    delay before the session/load response (default 20)
 *   FAKE_AGENT_NEW_DELAY_MS=n     delay before the session/new response (default 0)
 *   FAKE_AGENT_STORE=<file.json>  keeps sessions in this file, so they survive a restart (like Cursor's own store)
 *   CURSOR_CONFIG_DIR=<dir>       session/load of an unknown id replays the turns of <dir>/acp-sessions/<id>/store.db
 */
import readline from "node:readline";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** The user texts of a session in Cursor's own store layout (see src/extension/session/forkStore.ts). */
function storedTurns(sessionId) {
  const dir = process.env.CURSOR_CONFIG_DIR;
  const path = dir && join(dir, "acp-sessions", sessionId, "store.db");
  if (!path || !existsSync(path)) return undefined;
  const fields = (bytes) => {
    const out = [];
    let i = 0;
    const varint = () => {
      let n = 0;
      let scale = 1;
      for (;;) {
        const b = bytes[i++];
        n += (b & 0x7f) * scale;
        if (!(b & 0x80)) return n;
        scale *= 128;
      }
    };
    while (i < bytes.length) {
      const key = varint();
      if (key % 8 === 0) out.push([Math.floor(key / 8), varint()]);
      else {
        const length = varint();
        out.push([Math.floor(key / 8), bytes.subarray(i, i + length)]);
        i += length;
      }
    }
    return out;
  };
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const blob = (id) => db.prepare("SELECT data FROM blobs WHERE id = ?").get(Buffer.from(id).toString("hex")).data;
    const meta = JSON.parse(Buffer.from(db.prepare("SELECT value FROM meta WHERE key = '0'").get().value, "hex").toString());
    const root = fields(db.prepare("SELECT data FROM blobs WHERE id = ?").get(meta.latestRootBlobId).data);
    return root
      .filter(([f]) => f === 8)
      .map(([, turnRef]) => {
        const turn = fields(fields(blob(turnRef)).find(([f]) => f === 1)[1]);
        const prompt = fields(blob(turn.find(([f]) => f === 1)[1]));
        return Buffer.from(prompt.find(([f]) => f === 1)[1]).toString();
      });
  } finally {
    db.close();
  }
}

const STORE = process.env.FAKE_AGENT_STORE;
function readStore() {
  if (!STORE || !existsSync(STORE)) return undefined;
  // A previous agent process may still be writing it; a partial file counts as empty.
  try {
    return JSON.parse(readFileSync(STORE, "utf8"));
  } catch {
    return undefined;
  }
}
const stored = readStore();
const sessions = new Map(stored?.sessions ?? []);
let nextId = stored?.nextId ?? 1000;
// Session ids are unique per agent process (a restarted agent never reuses one), like Cursor's UUIDs.
const idPrefix = randomBytes(3).toString("hex");
function persist() {
  if (!STORE) return;
  // Write then rename, so another agent process never reads a half-written file.
  const tmp = `${STORE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ nextId, sessions: [...sessions] }));
  renameSync(tmp, STORE);
}
const pending = new Map();
let cancelled = false;

function send(msg) {
  persist();
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function notify(sessionId, update) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}
const sleep = (ms) =>
  new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (cancelled || Date.now() - start >= ms) resolve();
      else setTimeout(tick, 10);
    };
    tick();
  });

const modes = {
  currentModeId: "agent",
  availableModes: [
    { id: "agent", name: "Agent", description: "Full agent" },
    { id: "ask", name: "Ask", description: "Q&A" },
  ],
};
const models = {
  currentModelId: "model-a",
  availableModels: [
    { modelId: "model-a", name: "Model A" },
    { modelId: "model-b", name: "Model B" },
  ],
};
function configOptions(sessionId) {
  const s = sessions.get(sessionId);
  return [
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: s.mode, options: modes.availableModes.map((m) => ({ value: m.id, name: m.name })) },
    { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: models.availableModels.map((m) => ({ value: m.modelId, name: m.name })) },
  ];
}

async function handlePrompt(id, params) {
  const sessionId = params.sessionId;
  const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
  const session = sessions.get(sessionId);
  session.history.push({ role: "user", text });
  cancelled = false;
  const finish = (stopReason) => send({ jsonrpc: "2.0", id, result: { stopReason } });

  if (text.startsWith("crash")) {
    process.exit(3);
  }
  if (text.startsWith("askcrash")) {
    void request("cursor/ask_question", {
      toolCallId: "q-crash",
      title: "Still there?",
      questions: [{ id: "q", prompt: "Which?", options: [{ id: "x", label: "X" }] }],
    });
    setTimeout(() => process.exit(4), 50);
    return;
  }
  if (text.startsWith("editrepeat ")) {
    const path = text.slice(11);
    const toolCallId = `call-${nextId++}`;
    const content = [{ type: "diff", path, oldText: "a\nb\nc\n", newText: "a\nB\nc\nd\n" }];
    notify(sessionId, { sessionUpdate: "tool_call", toolCallId, title: `Edit \`${path}\``, kind: "edit", status: "pending", rawInput: { path } });
    for (const status of ["in_progress", "in_progress", "completed", "completed"]) {
      notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status, content });
    }
    finish("end_turn");
    return;
  }
  if (text.startsWith("fail")) {
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Something went wrong communicating with the server." } });
    return;
  }
  if (text.startsWith("sleep")) {
    const ms = Number(text.split(" ")[1] ?? "1000");
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "sleeping…" } });
    await sleep(ms);
    finish(cancelled ? "cancelled" : "end_turn");
    return;
  }
  if (text.startsWith("mcp list")) {
    const names = (session.mcpServers ?? []).map((m) => `${m.name}${m.command ? ` (${m.command} ${(m.args ?? []).join(" ")})` : m.url ? ` (${m.url})` : ""}`);
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: names.length ? `MCP: ${names.join("; ")}` : "MCP: none" } });
    finish("end_turn");
    return;
  }
  if (text.startsWith("mcp call ")) {
    // Mirrors Cursor's MCP tool flow: a generic tool_call, an update with the provider/tool in rawInput,
    // then a permission request whose content is the arguments (no "Not in allowlist" reason).
    const [server, tool] = text.slice(9).trim().split(/\s+/);
    const toolCallId = `call-${nextId++}\nfc_m`;
    notify(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "MCP: tool", kind: "other", status: "pending" });
    notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId, title: `${server}: ${tool}`, rawInput: { providerIdentifier: server, toolName: tool, args: { text: "hi" } } });
    const permission = await request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId, title: `${server}-${tool}: ${tool}`, kind: "other", status: "pending", content: [{ type: "content", content: { type: "text", text: "```json\n{\n  \"text\": \"hi\"\n}\n```" } }] },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    if (permission.outcome.outcome !== "selected" || permission.outcome.optionId.startsWith("reject")) {
      notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
      finish("end_turn");
      return;
    }
    notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: "ECHO:hi" } }] });
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Tool said ECHO:hi" } });
    finish("end_turn");
    return;
  }
  if (text.startsWith("run ")) {
    const command = text.slice(4);
    const toolCallId = `call-${nextId++}\nfc_x`;
    notify(sessionId, { sessionUpdate: "tool_call", toolCallId, title: `\`${command}\``, kind: "execute", status: "pending", rawInput: { command } });
    notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
    const permission = await request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId, title: `\`${command}\``, kind: "execute", status: "pending", content: [{ type: "content", content: { type: "text", text: "Not in allowlist: echo" } }] },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    if (permission.outcome.outcome === "cancelled") {
      notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
      finish("cancelled");
      return;
    }
    if (permission.outcome.optionId.startsWith("reject")) {
      notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed", rawOutput: { error: "rejected by user" } });
      notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Okay, I won't run that." } });
      finish("end_turn");
      return;
    }
    notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", rawOutput: { exitCode: 0, stdout: "hello\n", stderr: "" } });
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done: printed hello." } });
    session.history.push({ role: "assistant", text: "Done: printed hello." });
    finish("end_turn");
    return;
  }
  if (text.startsWith("edit ")) {
    const path = text.slice(5);
    const toolCallId = `call-${nextId++}`;
    notify(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "Edit File", kind: "edit", status: "pending", rawInput: {} });
    notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId, title: `Edit \`${path}\``, rawInput: { path }, locations: [{ path }] });
    notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
    notify(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      content: [{ type: "diff", path, oldText: "a\nb\nc\n", newText: "a\nB\nc\nd\n" }],
    });
    finish("end_turn");
    return;
  }
  if (text.startsWith("ask")) {
    const answer = await request("cursor/ask_question", {
      toolCallId: "q1",
      title: "Pick one",
      questions: [{ id: "q", prompt: "Which?", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] }],
    });
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `You said ${JSON.stringify(answer.outcome)}` } });
    finish("end_turn");
    return;
  }
  if (text.startsWith("plan")) {
    send({ jsonrpc: "2.0", method: "cursor/update_todos", params: { toolCallId: "t1", merge: false, todos: [{ id: "1", content: "First", status: "pending" }] } });
    const result = await request("cursor/create_plan", { toolCallId: "p1", name: "My plan", plan: "# Plan\n\n1. do it", todos: [{ id: "1", content: "First", status: "pending" }] });
    send({ jsonrpc: "2.0", method: "cursor/update_todos", params: { toolCallId: "t1", merge: true, todos: [{ id: "1", content: "First", status: "completed" }] } });
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Plan ${result.outcome.outcome}` } });
    finish("end_turn");
    return;
  }
  // echo
  notify(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking " } });
  notify(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "about it." } });
  for (const part of ["Echo: ", text, "!"]) {
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: part } });
  }
  session.history.push({ role: "assistant", text: `Echo: ${text}!` });
  notify(sessionId, { sessionUpdate: "session_info_update", title: `Echo ${text.slice(0, 10)}` });
  finish("end_turn");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.method === undefined) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
    return;
  }
  const { id, method, params } = msg;
  const reply = (result) => send({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      if (process.env.FAKE_AGENT_CRASH_ON_INIT) {
        process.stderr.write("fake agent: refusing to start\n");
        process.exit(2);
      }
      reply({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { list: {} } },
        authMethods: [{ id: "cursor_login", name: "Cursor Login" }],
        agentInfo: { name: "fake-agent", version: "0.0.1" },
      });
      return;
    case "authenticate":
      if (process.env.FAKE_AGENT_AUTH_FAIL) send({ jsonrpc: "2.0", id, error: { code: -32001, message: "Not logged in" } });
      else reply({});
      return;
    case "session/new": {
      const sessionId = `s-${idPrefix}-${nextId++}`;
      sessions.set(sessionId, { cwd: params.cwd, history: [], mode: "agent", model: "model-a", title: undefined, mcpServers: params.mcpServers ?? [] });
      const newDelay = Number(process.env.FAKE_AGENT_NEW_DELAY_MS ?? "0");
      setTimeout(() => {
        reply({ sessionId, modes, models, configOptions: configOptions(sessionId) });
        setTimeout(() => notify(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compress", description: "Compress context" }] }), 5);
      }, newDelay);
      return;
    }
    case "session/list":
      reply({ sessions: Array.from(sessions, ([sessionId, s]) => ({ sessionId, cwd: s.cwd, title: s.title ?? "Untitled", updatedAt: new Date().toISOString() })) });
      return;
    case "session/load": {
      if (!sessions.has(params.sessionId)) {
        const turns = storedTurns(params.sessionId);
        const history = turns?.flatMap((text) => [{ role: "user", text }, { role: "assistant", text: `Echo: ${text}!` }]);
        if (history) sessions.set(params.sessionId, { cwd: params.cwd, history, mode: "agent", model: "model-a", title: undefined, mcpServers: [] });
      }
      const s = sessions.get(params.sessionId);
      if (!s) {
        send({ jsonrpc: "2.0", id, error: { code: -32002, message: "Session not found" } });
        return;
      }
      s.mcpServers = params.mcpServers ?? [];
      // Replay history *before* answering, exactly like Cursor does.
      for (const entry of s.history) {
        notify(params.sessionId, { sessionUpdate: entry.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: entry.text } });
      }
      setTimeout(() => reply({ modes, models, configOptions: configOptions(params.sessionId) }), Number(process.env.FAKE_AGENT_LOAD_DELAY_MS ?? "20"));
      return;
    }
    case "session/prompt":
      void handlePrompt(id, params);
      return;
    case "session/cancel":
      // Outstanding permission requests are answered "cancelled" by the client; nothing to do here.
      cancelled = true;
      return;
    case "session/set_config_option": {
      const s = sessions.get(params.sessionId);
      if (params.configId === "mode") s.mode = params.value;
      if (params.configId === "model") s.model = params.value;
      reply({ configOptions: configOptions(params.sessionId) });
      return;
    }
    case "cursor/list_available_models":
      reply({
        models: [
          { value: "model-a", name: "Model A", configOptions: [{ id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] }] },
          { value: "model-b", name: "Model B" },
        ],
      });
      return;
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown ${method}` } });
  }
});
rl.on("close", () => process.exit(0));
