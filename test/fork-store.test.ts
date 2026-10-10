import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ForkError, acpSessionsDirCandidates, findSessionDir, forkSession, matchTurn, parseProtobuf, readSessionTurns, type StoredTurn } from "../src/extension/session/forkStore";
import { buildSession, pb } from "./fixtures/cursorStore";

function readMeta(dir: string): Record<string, unknown> {
  const db = new DatabaseSync(join(dir, "store.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value: string };
    return JSON.parse(Buffer.from(row.value, "hex").toString("utf8"));
  } finally {
    db.close();
  }
}

function fingerprint(dir: string): string {
  const db = new DatabaseSync(join(dir, "store.db"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT id, hex(data) AS d FROM blobs ORDER BY id").all();
    const meta = db.prepare("SELECT value FROM meta").all();
    return JSON.stringify([rows, meta, readFileSync(join(dir, "meta.json"), "utf8")]);
  } finally {
    db.close();
  }
}

let tmp: string;
let sessionsDir: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fork-store-"));
  sessionsDir = join(tmp, "acp-sessions");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const SOURCE = "11111111-1111-4111-8111-111111111111";
const FORK = "22222222-2222-4222-8222-222222222222";
const PROMPTS = ["Remember marker ALPHA-1.", "Read notes.txt and tell me the secret.", "Remember marker GAMMA-3."];

describe("parseProtobuf", () => {
  it("reads varints past 32 bits, nested bytes and fixed-width fields", () => {
    const bytes = Uint8Array.from([...pb([26, 1791547548400], [1, "hi"]), 0x2d, 1, 2, 3, 4, 0x31, 1, 2, 3, 4, 5, 6, 7, 8]);
    const fields = parseProtobuf(bytes);
    expect(fields.map((f) => [f.field, f.wire])).toEqual([[26, 0], [1, 2], [5, 5], [6, 1]]);
    expect(fields[0]!.value).toBe(1791547548400);
    expect(Buffer.from(fields[1]!.value as Uint8Array).toString()).toBe("hi");
  });

  it("rejects truncated or unknown data", () => {
    expect(() => parseProtobuf(Uint8Array.from([0x0a, 5, 1]))).toThrow(ForkError);
    expect(() => parseProtobuf(Uint8Array.from([0x0b]))).toThrow(ForkError);
    expect(() => parseProtobuf(Uint8Array.from([0x08, 0x80]))).toThrow(ForkError);
  });
});

describe("readSessionTurns", () => {
  it("lists each turn's text and the root it started from", () => {
    const built = buildSession(sessionsDir, SOURCE, PROMPTS);
    const turns = readSessionTurns(sessionsDir, SOURCE);
    expect(turns.map((t) => t.text)).toEqual(PROMPTS);
    expect(turns.map((t) => t.rootBefore)).toEqual(built.roots.slice(0, 3));
  });
});

describe("matchTurn", () => {
  const turns: StoredTurn[] = PROMPTS.map((text, i) => ({ text, rootBefore: String(i) }));

  it("trusts the position when the text agrees, including appended attachment context", () => {
    expect(matchTurn(turns, 1, "Read notes.txt and tell me the secret.", 3)).toBe(1);
    const withContext: StoredTurn[] = [{ text: "Fix this\n\nReferenced file: src/a.ts", rootBefore: "r" }];
    expect(matchTurn(withContext, 0, "Fix this", 1)).toBe(0);
  });

  it("trusts the position when both sides have the same number of messages (slash commands are saved expanded)", () => {
    expect(matchTurn(turns, 2, "/review", 3)).toBe(2);
  });

  it("finds the nearest turn with the same text when the transcript has an unsaved message", () => {
    // The transcript shows a prompt that failed before Cursor saved it, so positions are off by one.
    expect(matchTurn(turns, 3, "Remember marker GAMMA-3.", 4)).toBe(2);
    expect(matchTurn(turns, 1, "Remember marker ALPHA-1.", 4)).toBe(0);
  });

  it("refuses when the message cannot be found", () => {
    expect(() => matchTurn(turns, 3, "Something never sent", 4)).toThrow(ForkError);
    expect(() => matchTurn(turns, 3, "", 4)).toThrow(ForkError);
  });
});

describe("forkSession", () => {
  it("copies the session up to the end of a turn and leaves the source untouched", async () => {
    const built = buildSession(sessionsDir, SOURCE, PROMPTS);
    const before = fingerprint(built.dir);

    const fork = await forkSession({ sessionsDir, sessionId: SOURCE, turnIndex: 1, text: PROMPTS[1]!, shownCount: 3, newSessionId: FORK });

    expect(fork).toEqual({ sessionId: FORK, title: "Test chat (fork)", turnIndex: 1 });
    expect(fingerprint(built.dir)).toBe(before);
    const meta = readMeta(join(sessionsDir, FORK));
    // Where the next turn started from: everything up to and including turn 2.
    expect(meta).toMatchObject({ agentId: FORK, latestRootBlobId: built.roots[2], name: "Test chat (fork)", mode: "default", blobEncryptionKey: "k" });
    expect(JSON.parse(readFileSync(join(sessionsDir, FORK, "meta.json"), "utf8"))).toEqual({ schemaVersion: 1, cwd: "/work/project", title: "Test chat (fork)" });
    expect(readSessionTurns(sessionsDir, FORK).map((t) => t.text)).toEqual(PROMPTS.slice(0, 2));
    // The copy stands alone: no WAL left to replay.
    expect(readdirSync(join(sessionsDir, FORK)).sort()).toEqual(["meta.json", "store.db"]);
  });

  it("forks after the last turn into a full copy", async () => {
    const built = buildSession(sessionsDir, SOURCE, PROMPTS);
    await forkSession({ sessionsDir, sessionId: SOURCE, turnIndex: 2, text: PROMPTS[2]!, shownCount: 3, newSessionId: FORK });
    expect(readMeta(join(sessionsDir, FORK)).latestRootBlobId).toBe(built.roots[3]);
    expect(readSessionTurns(sessionsDir, FORK).map((t) => t.text)).toEqual(PROMPTS);
  });

  it("forks after the first turn, under a renamed title", async () => {
    const built = buildSession(sessionsDir, SOURCE, PROMPTS);
    await forkSession({ sessionsDir, sessionId: SOURCE, turnIndex: 0, text: PROMPTS[0]!, shownCount: 3, newSessionId: FORK, title: "Renamed" });
    expect(readMeta(join(sessionsDir, FORK))).toMatchObject({ latestRootBlobId: built.roots[1], name: "Renamed (fork)" });
    expect(readSessionTurns(sessionsDir, FORK).map((t) => t.text)).toEqual(PROMPTS.slice(0, 1));
  });

  it("can fork a fork", async () => {
    buildSession(sessionsDir, SOURCE, PROMPTS);
    await forkSession({ sessionsDir, sessionId: SOURCE, turnIndex: 1, text: PROMPTS[1]!, shownCount: 3, newSessionId: FORK });
    const again = await forkSession({ sessionsDir, sessionId: FORK, turnIndex: 0, text: PROMPTS[0]!, shownCount: 2 });
    expect(readSessionTurns(sessionsDir, again.sessionId).map((t) => t.text)).toEqual(PROMPTS.slice(0, 1));
    expect(again.title).toBe("Test chat (fork) (fork)");
  });

  it("sees data the agent has not checkpointed yet", async () => {
    const built = buildSession(sessionsDir, SOURCE, PROMPTS.slice(0, 2));
    // Keep a writer open (as the agent does) so the latest state lives only in the WAL.
    const writer = new DatabaseSync(join(built.dir, "store.db"));
    try {
      writer.exec("PRAGMA wal_autocheckpoint = 0");
      const extra = buildSession(join(tmp, "scratch"), SOURCE, PROMPTS);
      const insert = writer.prepare("INSERT OR IGNORE INTO blobs (id, data) VALUES (?, ?)");
      for (const [id, data] of extra.store.blobs) insert.run(id, data);
      const meta = { agentId: SOURCE, latestRootBlobId: extra.roots[3], name: "Test chat" };
      writer.prepare("UPDATE meta SET value = ? WHERE key = '0'").run(Buffer.from(JSON.stringify(meta)).toString("hex"));
      const fork = await forkSession({ sessionsDir, sessionId: SOURCE, turnIndex: 2, text: PROMPTS[2]!, shownCount: 3, newSessionId: FORK });
      expect(fork.turnIndex).toBe(2);
      expect(readSessionTurns(sessionsDir, FORK).map((t) => t.text)).toEqual(PROMPTS);
    } finally {
      writer.close();
    }
  });

  it("fails cleanly, leaving nothing behind, when the store is not what it expects", async () => {
    const built = buildSession(sessionsDir, SOURCE, PROMPTS);
    const db = new DatabaseSync(join(built.dir, "store.db"));
    db.prepare("DELETE FROM blobs WHERE id = ?").run(built.roots[2]!);
    db.close();
    await expect(forkSession({ sessionsDir, sessionId: SOURCE, turnIndex: 1, text: PROMPTS[1]!, shownCount: 3, newSessionId: FORK })).rejects.toThrow(/missing/);
    expect(existsSync(join(sessionsDir, FORK))).toBe(false);
  });

  it("refuses a store with tampered blobs", async () => {
    const built = buildSession(sessionsDir, SOURCE, PROMPTS);
    const db = new DatabaseSync(join(built.dir, "store.db"));
    db.prepare("UPDATE blobs SET data = ? WHERE id = ?").run(Buffer.from("{}"), built.roots[2]!);
    db.close();
    await expect(forkSession({ sessionsDir, sessionId: SOURCE, turnIndex: 1, text: PROMPTS[1]!, shownCount: 3, newSessionId: FORK })).rejects.toThrow(/does not match/);
    expect(existsSync(join(sessionsDir, FORK))).toBe(false);
  });

  it("refuses an unknown meta.json schema and a store of another session", async () => {
    const built = buildSession(sessionsDir, SOURCE, PROMPTS);
    writeFileSync(join(built.dir, "meta.json"), JSON.stringify({ schemaVersion: 2, cwd: "/work/project" }));
    await expect(forkSession({ sessionsDir, sessionId: SOURCE, turnIndex: 1, text: PROMPTS[1]!, shownCount: 3 })).rejects.toThrow(/meta\.json/);

    buildSession(sessionsDir, FORK, PROMPTS);
    const other = join(sessionsDir, "33333333-3333-4333-8333-333333333333");
    mkdirSync(other);
    writeFileSync(join(other, "meta.json"), readFileSync(join(sessionsDir, FORK, "meta.json")));
    writeFileSync(join(other, "store.db"), readFileSync(join(sessionsDir, FORK, "store.db")));
    await expect(forkSession({ sessionsDir, sessionId: "33333333-3333-4333-8333-333333333333", turnIndex: 1, text: PROMPTS[1]!, shownCount: 3 })).rejects.toThrow(/different session/);
  });
});

describe("locating sessions", () => {
  it("follows the CLI's lookup order, then the extra folders, without duplicates", () => {
    const env = { HOME: "/home/u", XDG_CONFIG_HOME: "/xdg", CURSOR_CONFIG_DIR: "/custom" };
    expect(acpSessionsDirCandidates(env, ["~/.cursor", undefined, " "])).toEqual([join("/custom", "acp-sessions"), join("/home/u", ".cursor", "acp-sessions"), join("/xdg", "cursor", "acp-sessions")]);
    expect(acpSessionsDirCandidates({ HOME: "/home/u" })).toEqual([join("/home/u", ".cursor", "acp-sessions")]);
  });

  it("picks the folder that holds the session", () => {
    buildSession(sessionsDir, SOURCE, PROMPTS);
    expect(findSessionDir([join(tmp, "nope"), sessionsDir], SOURCE)).toBe(sessionsDir);
    expect(findSessionDir([sessionsDir], FORK)).toBeUndefined();
  });
});
