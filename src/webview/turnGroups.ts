import type { ThreadItem } from "../shared/protocol";

/** `forkFrom`: on the last agent group of a turn, the user message that started the turn. */
export type Group = { key: string; kind: "user" | "agent" | "solo"; ids: string[]; forkFrom?: string };

/** Group consecutive agent-side items into one "turn" so they share a gutter. */
export function groupIds(ids: ReadonlyArray<string>, items: ReadonlyMap<string, ThreadItem>): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastUser: string | undefined;
  let lastAgent: Group | null = null;
  for (const id of ids) {
    const it = items.get(id);
    if (!it) continue;
    if (it.type === "user") {
      current = null;
      if (lastAgent && lastUser) lastAgent.forkFrom = lastUser;
      lastUser = id;
      lastAgent = null;
      groups.push({ key: id, kind: "user", ids: [id] });
    } else if (it.type === "notice" || it.type === "divider") {
      current = null;
      groups.push({ key: id, kind: "solo", ids: [id] });
    } else {
      if (!current || current.kind !== "agent") {
        current = { key: id, kind: "agent", ids: [] };
        groups.push(current);
        lastAgent = current;
      }
      current.ids.push(id);
    }
  }
  if (lastAgent && lastUser) lastAgent.forkFrom = lastUser;
  return groups;
}
