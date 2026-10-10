/** Builds session stores laid out like the Cursor CLI's `acp-sessions/<id>/` (see src/extension/session/forkStore.ts). */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 128) {
    out.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

export type Value = string | number | Uint8Array;
export function pb(...fields: Array<[number, Value]>): Uint8Array {
  const out: number[] = [];
  for (const [no, value] of fields) {
    if (typeof value === "number") {
      out.push(...varint(no * 8), ...varint(value));
    } else {
      const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
      out.push(...varint(no * 8 + 2), ...varint(bytes.length), ...bytes);
    }
  }
  return Uint8Array.from(out);
}

export const ref = (id: string) => Uint8Array.from(Buffer.from(id, "hex"));

export class FakeStore {
  readonly blobs = new Map<string, Uint8Array>();
  put(data: Uint8Array | object): string {
    const bytes = data instanceof Uint8Array ? data : Buffer.from(JSON.stringify(data), "utf8");
    const id = createHash("sha256").update(bytes).digest("hex");
    this.blobs.set(id, bytes);
    return id;
  }
}

export interface Built {
  readonly dir: string;
  /** Roots before each turn, then the final root. */
  readonly roots: string[];
  readonly store: FakeStore;
}

export function buildSession(sessionsDir: string, sessionId: string, prompts: string[], title = "Test chat"): Built {
  const store = new FakeStore();
  const messages = [store.put({ role: "system", content: "system prompt" }), store.put({ role: "user", content: "<user_info>" })];
  const turns: string[] = [];
  const root = () => store.put(pb(...messages.map((m): [number, Value] => [1, ref(m)]), ...turns.map((t): [number, Value] => [8, ref(t)]), [22, "cli"], [26, 1791547548400]));
  const roots = [root()];
  prompts.forEach((text, i) => {
    const prompt = store.put(pb([1, text], [2, `req-${i}`], [4, 1], [10, ref(roots[i]!)]));
    const step = store.put(pb([1, pb([1, `reply ${i}`])]));
    turns.push(store.put(pb([1, pb([1, ref(prompt)], [2, ref(step)], [3, `id-${i}`])])));
    messages.push(store.put({ role: "user", content: [{ type: "text", text: `<user_query>${text}</user_query>` }] }), store.put({ role: "assistant", content: [{ type: "text", text: `reply ${i}` }] }));
    roots.push(root());
  });
  const dir = join(sessionsDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "store.db"));
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);");
  const insert = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
  for (const [id, data] of store.blobs) insert.run(id, data);
  const meta = { agentId: sessionId, latestRootBlobId: roots[roots.length - 1], name: title, mode: "default", createdAt: 1, blobEncryptionKey: "k" };
  db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(Buffer.from(JSON.stringify(meta), "utf8").toString("hex"));
  db.close();
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ schemaVersion: 1, cwd: "/work/project", title }));
  return { dir, roots, store };
}
