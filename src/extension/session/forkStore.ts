/**
 * Forks a Cursor ACP session after one of its agent turns ("fork from here").
 *
 * ACP has no way to do this (the unstable `session/fork` copies a whole
 * session, and Cursor does not offer it), so this works on the CLI's own
 * storage: `<config dir>/acp-sessions/<id>/` with a `meta.json` and a SQLite
 * `store.db`. The store is content-addressed:
 *
 * - `blobs(id, data)`: `id` is the hex SHA-256 of `data`; messages are JSON,
 *   everything else is protobuf.
 * - `meta` row `"0"`: hex-encoded JSON with `agentId` (the session id) and
 *   `latestRootBlobId`, the conversation state the CLI loads.
 * - The root blob lists the conversation's turns (field 8). A turn (field 1)
 *   points at its prompt record (field 1), which holds the user's text
 *   (field 1) and the root the turn started from (field 10).
 *
 * So the state "right after turn k" is a root the CLI wrote itself: the one
 * turn k+1 started from, or the latest root after the last turn. The fork is a
 * copy of the store whose `latestRootBlobId` points at that root; nothing is
 * synthesised and the source session is only read.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const META_SCHEMA_VERSION = 1;

export class ForkError extends Error {
  override readonly name = "ForkError";
}

// --- protobuf (just enough to walk the CLI's records) ------------------------------------

interface PbField {
  readonly field: number;
  readonly wire: number;
  /** Varints as numbers; length-delimited fields as their bytes. */
  readonly value: number | Uint8Array;
}

function readVarint(bytes: Uint8Array, start: number): [number, number] {
  let result = 0;
  let scale = 1;
  let i = start;
  for (;;) {
    if (i >= bytes.length) throw new ForkError("Truncated varint.");
    const byte = bytes[i++]!;
    result += (byte & 0x7f) * scale;
    if (!(byte & 0x80)) return [result, i];
    scale *= 128;
    if (scale > 2 ** 63) throw new ForkError("Varint too long.");
  }
}

export function parseProtobuf(bytes: Uint8Array): PbField[] {
  const fields: PbField[] = [];
  let i = 0;
  while (i < bytes.length) {
    const [key, next] = readVarint(bytes, i);
    i = next;
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (field === 0) throw new ForkError("Invalid protobuf field number.");
    let value: number | Uint8Array;
    if (wire === 0) {
      [value, i] = readVarint(bytes, i);
    } else if (wire === 2) {
      const [length, at] = readVarint(bytes, i);
      if (at + length > bytes.length) throw new ForkError("Truncated protobuf field.");
      value = bytes.subarray(at, at + length);
      i = at + length;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (i + size > bytes.length) throw new ForkError("Truncated protobuf field.");
      value = bytes.subarray(i, i + size);
      i += size;
    } else {
      throw new ForkError(`Unsupported protobuf wire type ${wire}.`);
    }
    fields.push({ field, wire, value });
  }
  return fields;
}

function bytesOf(fields: ReadonlyArray<PbField>, field: number): Uint8Array[] {
  return fields.filter((f) => f.field === field && f.wire === 2).map((f) => f.value as Uint8Array);
}

function hashOf(fields: ReadonlyArray<PbField>, field: number): string | undefined {
  const value = bytesOf(fields, field)[0];
  return value && value.length === 32 ? Buffer.from(value).toString("hex") : undefined;
}

// --- locating sessions -------------------------------------------------------------------

/**
 * Where the CLI may keep ACP sessions, most specific first. The CLI uses
 * `CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor`;
 * `extraConfigDirs` covers a config dir set by a wrapper script or the settings.
 */
export function acpSessionsDirCandidates(env: NodeJS.ProcessEnv, extraConfigDirs: ReadonlyArray<string | undefined> = []): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const expand = (dir: string) => (dir === "~" || /^~[\\/]/.test(dir) ? join(home, dir.slice(1)) : dir);
  const dirs = [env.CURSOR_CONFIG_DIR, ...extraConfigDirs, env.XDG_CONFIG_HOME?.trim() ? join(env.XDG_CONFIG_HOME.trim(), "cursor") : undefined, join(home, ".cursor")];
  return [...new Set(dirs.map((d) => d?.trim()).filter((d): d is string => !!d).map((d) => join(expand(d), "acp-sessions")))];
}

export function findSessionDir(sessionsDirs: ReadonlyArray<string>, sessionId: string): string | undefined {
  for (const dir of sessionsDirs) {
    if (existsSync(join(dir, sessionId, "store.db"))) return dir;
  }
  return undefined;
}

// --- reading a store ---------------------------------------------------------------------

type Sqlite = typeof import("node:sqlite");

function loadSqlite(): Sqlite {
  let sqlite: Sqlite | undefined;
  try {
    sqlite = process.getBuiltinModule?.("node:sqlite") as Sqlite | undefined;
  } catch {
    sqlite = undefined;
  }
  if (!sqlite?.DatabaseSync) throw new ForkError(`Forking needs SQLite support in VS Code's Node.js (${process.version}); update VS Code.`);
  return sqlite;
}

interface StoreMeta {
  agentId: string;
  latestRootBlobId: string;
  name?: string;
  [key: string]: unknown;
}

export interface StoredTurn {
  /** The user's text as the CLI saved it (with any context the extension appended). */
  readonly text: string;
  /** The root blob the conversation was at right before this turn. */
  readonly rootBefore: string;
}

function readMeta(db: DatabaseSync): StoreMeta {
  const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value?: unknown } | undefined;
  if (typeof row?.value !== "string") throw new ForkError("The session store has no metadata.");
  let meta: unknown;
  try {
    meta = JSON.parse(Buffer.from(row.value, "hex").toString("utf8"));
  } catch {
    throw new ForkError("The session metadata could not be read.");
  }
  const m = meta as Partial<StoreMeta> | null;
  if (!m || typeof m !== "object" || typeof m.agentId !== "string" || typeof m.latestRootBlobId !== "string") {
    throw new ForkError("The session metadata is not in a format this extension knows.");
  }
  return m as StoreMeta;
}

function readBlob(db: DatabaseSync, id: string): Uint8Array {
  const row = db.prepare("SELECT data FROM blobs WHERE id = ?").get(id) as { data?: unknown } | undefined;
  if (!(row?.data instanceof Uint8Array)) throw new ForkError(`Blob ${id.slice(0, 12)} is missing from the session store.`);
  if (createHash("sha256").update(row.data).digest("hex") !== id) throw new ForkError(`Blob ${id.slice(0, 12)} does not match its id.`);
  return row.data;
}

/** The root must list messages that are all in the store; anything else is not a root we understand. */
function checkRoot(db: DatabaseSync, id: string): void {
  const fields = parseProtobuf(readBlob(db, id));
  for (const message of bytesOf(fields, 1)) {
    if (message.length !== 32) throw new ForkError("A conversation root is not in a format this extension knows.");
    const json = readBlob(db, Buffer.from(message).toString("hex"));
    if (json[0] !== 0x7b) throw new ForkError("A conversation message is not in a format this extension knows.");
  }
}

function readTurns(db: DatabaseSync, rootId: string): StoredTurn[] {
  const root = parseProtobuf(readBlob(db, rootId));
  return bytesOf(root, 8).map((ref, index) => {
    const fail = (): never => {
      throw new ForkError(`Turn ${index + 1} of the saved session is not in a format this extension knows.`);
    };
    if (ref.length !== 32) fail();
    const turn = bytesOf(parseProtobuf(readBlob(db, Buffer.from(ref).toString("hex"))), 1)[0] ?? fail();
    const promptId = hashOf(parseProtobuf(turn), 1) ?? fail();
    const prompt = parseProtobuf(readBlob(db, promptId));
    const text = bytesOf(prompt, 1)[0];
    const rootBefore = hashOf(prompt, 10) ?? fail();
    return { text: text ? Buffer.from(text).toString("utf8") : "", rootBefore };
  });
}

function openReadOnly(sqlite: Sqlite, path: string): DatabaseSync {
  try {
    return new sqlite.DatabaseSync(path, { readOnly: true });
  } catch (error) {
    throw new ForkError(`Could not open ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Reads the saved turns of a session, oldest first. */
export function readSessionTurns(sessionsDir: string, sessionId: string): StoredTurn[] {
  const db = openReadOnly(loadSqlite(), join(sessionsDir, sessionId, "store.db"));
  try {
    return readTurns(db, readMeta(db).latestRootBlobId);
  } finally {
    db.close();
  }
}

// --- choosing the turn -------------------------------------------------------------------

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The saved text starts with what the transcript shows (the extension appends attachment context to prompts). */
function sameText(stored: string, shown: string): boolean {
  const a = normalise(stored);
  const b = normalise(shown);
  return a === b || (b.length > 0 && a.startsWith(b));
}

/**
 * Finds the saved turn for the transcript's `index`-th user message (0-based, of `shownCount`).
 * The position is trusted when the texts agree, or when both sides have the same number of
 * messages (a slash command is saved expanded); otherwise the nearest turn with the same text wins.
 */
export function matchTurn(turns: ReadonlyArray<StoredTurn>, index: number, text: string, shownCount: number): number {
  const at = turns[index];
  if (at && (sameText(at.text, text) || turns.length === shownCount)) return index;
  let best: number | undefined;
  turns.forEach((turn, i) => {
    if (sameText(turn.text, text) && normalise(text) && (best === undefined || Math.abs(i - index) < Math.abs(best - index))) best = i;
  });
  if (best === undefined) throw new ForkError("This message is not in Cursor's saved copy of the session.");
  return best;
}

// --- forking -----------------------------------------------------------------------------

export interface ForkOptions {
  readonly sessionsDir: string;
  readonly sessionId: string;
  /** 0-based index of the user message whose turn the fork ends with (later turns are left out). */
  readonly turnIndex: number;
  /** The message's text in the transcript, to check the index against the saved session. */
  readonly text: string;
  /** How many user messages the transcript shows. */
  readonly shownCount: number;
  readonly title?: string;
  /** For tests. */
  readonly newSessionId?: string;
}

export interface ForkResult {
  readonly sessionId: string;
  readonly title: string;
  /** The saved turn the fork ends with. */
  readonly turnIndex: number;
}

export async function forkSession(options: ForkOptions): Promise<ForkResult> {
  const sqlite = loadSqlite();
  const sourceDir = join(options.sessionsDir, options.sessionId);
  const sourceMeta = await readFolderMeta(sourceDir);

  const source = openReadOnly(sqlite, join(sourceDir, "store.db"));
  const newId = options.newSessionId ?? randomUUID();
  const targetDir = join(options.sessionsDir, newId);
  if (existsSync(targetDir)) throw new ForkError(`Session ${newId} already exists.`);
  let root: string;
  let turnIndex: number;
  let meta: StoreMeta;
  try {
    meta = readMeta(source);
    if (meta.agentId !== options.sessionId) throw new ForkError("The session store belongs to a different session.");
    const turns = readTurns(source, meta.latestRootBlobId);
    turnIndex = matchTurn(turns, options.turnIndex, options.text, options.shownCount);
    // The conversation as it stood when the turn finished: where the next turn started, or the latest state.
    root = turns[turnIndex + 1]?.rootBefore ?? meta.latestRootBlobId;
    checkRoot(source, root);
    await mkdir(targetDir, { recursive: true });
    // A consistent snapshot without the WAL, even while the agent has the session open.
    source.exec(`VACUUM INTO '${join(targetDir, "store.db").replace(/'/g, "''")}'`);
  } catch (error) {
    source.close();
    await rm(targetDir, { recursive: true, force: true });
    throw error;
  }
  source.close();

  const title = (options.title?.trim() || sourceMeta.title || meta.name || "Session") + " (fork)";
  try {
    const target = new sqlite.DatabaseSync(join(targetDir, "store.db"));
    try {
      const next: StoreMeta = { ...meta, agentId: newId, latestRootBlobId: root, name: title, createdAt: Date.now() };
      target.prepare("UPDATE meta SET value = ? WHERE key = '0'").run(Buffer.from(JSON.stringify(next), "utf8").toString("hex"));
      if (readMeta(target).latestRootBlobId !== root) throw new ForkError("The forked session could not be written.");
    } finally {
      target.close();
    }
    await writeFile(join(targetDir, "meta.json"), JSON.stringify({ ...sourceMeta.raw, schemaVersion: META_SCHEMA_VERSION, title }), "utf8");
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true });
    throw error;
  }
  return { sessionId: newId, title, turnIndex };
}

async function readFolderMeta(dir: string): Promise<{ raw: Record<string, unknown>; title?: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
  } catch {
    throw new ForkError(`The session has no readable meta.json in ${dir}.`);
  }
  const meta = raw as { schemaVersion?: unknown; cwd?: unknown; title?: unknown } | null;
  if (!meta || typeof meta !== "object" || meta.schemaVersion !== META_SCHEMA_VERSION || typeof meta.cwd !== "string") {
    throw new ForkError("The session's meta.json is not in a format this extension knows.");
  }
  return { raw: meta as Record<string, unknown>, ...(typeof meta.title === "string" && meta.title ? { title: meta.title } : {}) };
}
