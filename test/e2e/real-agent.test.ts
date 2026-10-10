/**
 * End-to-end test against the real Cursor Agent CLI. Skipped unless
 * CURSOR_ACP_E2E=1. Uses the `CURSOR_ACP_AGENT` executable (default:
 * ~/.local/bin/cursor-flexnet) and consumes a small amount of Cursor usage.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { ThreadItem, ToolItem } from "../../src/shared/protocol";
import { SessionRuntime } from "../../src/extension/session/SessionRuntime";

const enabled = process.env.CURSOR_ACP_E2E === "1";
const agent = process.env.CURSOR_ACP_AGENT ?? join(homedir(), ".local", "bin", "cursor-flexnet");

async function waitFor(predicate: () => boolean, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!enabled)("real Cursor agent", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cursor-acp-e2e-"));
  writeFileSync(join(cwd, "README.md"), "# e2e\n");
  let lastSession: string | undefined;
  const logs: string[] = [];
  const make = () =>
    new SessionRuntime({
      cwd,
      workspaceName: "e2e",
      getLaunchConfig: () => ({ command: agent, args: [], env: process.env, protocolLogging: true }),
      getApprovalConfig: () => ({ policy: "ask", safeList: [] }),
      getModelDefaults: () => ({}),
      storage: {
        getLastSessionId: () => lastSession,
        setLastSessionId: (id) => (lastSession = id),
        getSessionMeta: () => ({ titles: {}, hidden: [] }),
        setSessionMeta: () => undefined,
      },
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(`ERROR ${m}`), protocol: (d, l) => logs.push(`${d} ${l.slice(0, 300)}`), stderr: (t) => logs.push(`stderr ${t}`) },
      events: { message: () => {}, permissionRequested: () => {}, turnFinished: () => {}, questionAsked: () => {} },
    });
  const runtimes: SessionRuntime[] = [];
  afterAll(async () => {
    for (const r of runtimes) await r.dispose();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("runs a full session lifecycle: new, permission, edit, list, resume, cancel", async () => {
    const runtime = make();
    runtimes.push(runtime);
    await runtime.start();
    expect(runtime.state.connection, logs.join("\n")).toBe("ready");
    expect(runtime.state.modes?.availableModes.map((m) => m.id)).toContain("agent");
    expect(runtime.state.models?.availableModels.length).toBeGreaterThan(3);
    expect(runtime.state.sessionId).toBeDefined();

    // 1) command with permission
    const turn = runtime.prompt("Run `echo e2e-ok` in the shell and then reply with exactly: DONE", []);
    await waitFor(() => runtime.state.pendingPermissions === 1 || runtime.state.connection === "ready");
    const pending = runtime.model.getItems().find((i): i is ToolItem => i.type === "tool" && i.permission?.state === "pending");
    if (pending) runtime.respondToPermission(pending.permission!.requestId, "allow-once");
    await turn;
    expect(runtime.state.connection).toBe("ready");
    const tool = runtime.model.getItems().find((i): i is ToolItem => i.type === "tool" && i.kind === "execute");
    expect(tool?.status).toBe("completed");
    expect(tool?.output).toContain("e2e-ok");
    const items = runtime.model.getItems();
    expect(items.some((i) => i.type === "assistant")).toBe(true);
    expect(items[items.length - 1]?.type).toBe("turn_end");

    // 2) file edit → diff
    await runtime.prompt("Create a file named hello.txt containing the single line: hello world. Do not run any shell commands. Reply with exactly: DONE", []);
    await waitFor(() => runtime.state.connection === "ready");
    const edit = [...runtime.model.getItems()].reverse().find((i): i is ToolItem => i.type === "tool" && i.kind === "edit");
    expect(edit?.diffs[0]?.additions ?? 0).toBeGreaterThan(0);
    expect(existsSync(join(cwd, "hello.txt"))).toBe(true);
    expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toContain("hello world");
    expect(runtime.state.changedFiles.map((f) => f.displayPath)).toContain("hello.txt");

    // 3) list + resume
    const sessionId = runtime.state.sessionId!;
    const sessions = await runtime.listSessions();
    expect(sessions.map((s) => s.sessionId)).toContain(sessionId);
    await runtime.loadSession(sessionId);
    expect(runtime.state.connection).toBe("ready");
    const replayed = runtime.model.getItems();
    expect(replayed.filter((i) => i.type === "user").length).toBe(2);
    expect(replayed.every((i) => i.type === "divider" || i.replay === true)).toBe(true);
    expect(replayed.some((i) => i.type === "assistant" && (i as Extract<ThreadItem, { type: "assistant" }>).streaming)).toBe(false);

    // 4) cancel a long command while its permission is pending
    const long = runtime.prompt("Run `sleep 60` in the shell.", []);
    await waitFor(() => runtime.state.pendingPermissions === 1 || runtime.state.connection === "ready");
    const t0 = Date.now();
    await runtime.cancel();
    await long;
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(runtime.state.connection).toBe("ready");
    const end = [...runtime.model.getItems()].reverse().find((i) => i.type === "turn_end") as Extract<ThreadItem, { type: "turn_end" }>;
    expect(end.stopReason).toBe("cancelled");

    // 5) mode/model switching round-trips. Cursor persists the selected model globally for the
    //    CLI profile, so restore the original afterwards.
    await runtime.setMode("ask");
    expect(runtime.state.modes?.currentModeId).toBe("ask");
    await runtime.setMode("agent");
    const original = runtime.state.models!.currentModelId;
    const other = runtime.state.models!.availableModels.find((m) => m.modelId !== original)!;
    try {
      await runtime.setModel(other.modelId, false);
      expect(runtime.state.models?.currentModelId).toBe(other.modelId);
    } finally {
      await runtime.setModel(original, false);
    }
    expect(runtime.state.models?.currentModelId).toBe(original);
  }, 300_000);

  it("forks a session after a reply: the copy remembers only the turns up to it, the source keeps all", async () => {
    const runtime = make();
    runtimes.push(runtime);
    await runtime.start();
    const markers = ["ALPHA-1", "BETA-2", "GAMMA-3"];
    for (const marker of markers) {
      await runtime.prompt(`Remember the marker ${marker}. Do not use any tools. Reply with exactly: OK`, []);
      expect(runtime.state.connection, logs.join("\n")).toBe("ready");
    }
    const source = runtime.state.sessionId!;
    const users = () => runtime.model.getItems().filter((i): i is Extract<ThreadItem, { type: "user" }> => i.type === "user");
    const lastReply = () => [...runtime.model.getItems()].reverse().find((i): i is Extract<ThreadItem, { type: "assistant" }> => i.type === "assistant")?.text ?? "";
    const recall = "List every marker I asked you to remember in this conversation, comma-separated, nothing else. Do not use any tools.";

    // After the second reply: ALPHA and BETA, no GAMMA.
    await runtime.forkAfterTurn(users()[1]!.id);
    const fork = runtime.state.sessionId!;
    expect(fork).not.toBe(source);
    expect(runtime.state.connection, logs.join("\n")).toBe("ready");
    expect(users()).toHaveLength(2);
    expect(users().map((u) => u.text).join("\n")).toMatch(/ALPHA-1[\s\S]*BETA-2/);
    await runtime.prompt(recall, []);
    expect(lastReply()).toContain("ALPHA-1");
    expect(lastReply()).toContain("BETA-2");
    expect(lastReply()).not.toContain("GAMMA-3");
    expect((await runtime.listSessions()).find((s) => s.sessionId === fork)?.title).toMatch(/\(fork\)$/);

    // Forking the fork after its last reply copies all of it, including the turn just sent.
    await runtime.forkAfterTurn(users()[2]!.id);
    expect(runtime.state.connection, logs.join("\n")).toBe("ready");
    expect(runtime.state.sessionId).not.toBe(fork);
    expect(users()).toHaveLength(3);
    expect(lastReply()).toContain("BETA-2");

    await runtime.loadSession(source);
    expect(users().map((u) => u.text).join("\n")).toMatch(/ALPHA-1[\s\S]*BETA-2[\s\S]*GAMMA-3/);
    expect(users()).toHaveLength(3);
  }, 300_000);
});
