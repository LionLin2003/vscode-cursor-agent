import { describe, expect, it } from "vitest";
import type { ThreadItem } from "../src/shared/protocol";
import { groupIds } from "../src/webview/turnGroups";

type Kind = ThreadItem["type"];

/** Builds a transcript from `kind:id` entries, e.g. `user:u1`, `assistant:a1`. */
function transcript(...entries: string[]): { ids: string[]; items: Map<string, ThreadItem> } {
  const items = new Map<string, ThreadItem>();
  const ids = entries.map((entry) => {
    const [type, id] = entry.split(":") as [Kind, string];
    items.set(id, { type, id, createdAt: 0 } as unknown as ThreadItem);
    return id;
  });
  return { ids, items };
}

/** Where the fork buttons go: the ids of the agent groups that carry one, with the user message they fork after. */
function forkPoints(ids: string[], items: Map<string, ThreadItem>): Array<[string[], string]> {
  return groupIds(ids, items)
    .filter((g) => g.forkFrom)
    .map((g) => [g.ids, g.forkFrom!]);
}

describe("fork points in the transcript", () => {
  it("puts one on every finished agent turn, not just the last", () => {
    const entries = [1, 2, 3, 4, 5].flatMap((n) => [`user:u${n}`, `assistant:a${n}`, `turn_end:e${n}`]);
    const { ids, items } = transcript(...entries);
    expect(forkPoints(ids, items)).toEqual([1, 2, 3, 4, 5].map((n) => [[`a${n}`, `e${n}`], `u${n}`]));
  });

  it("keeps a turn's thoughts, tools and messages together under its one button", () => {
    const { ids, items } = transcript("user:u1", "thought:t1", "tool:k1", "tool:k2", "assistant:a1", "todos:d1", "turn_end:e1");
    expect(forkPoints(ids, items)).toEqual([[["t1", "k1", "k2", "a1", "d1", "e1"], "u1"]]);
  });

  it("covers replayed history before the resume divider and the live turns after it", () => {
    // Replayed turns have no turn_end; the divider closes the replay.
    const { ids, items } = transcript("user:u1", "assistant:a1", "user:u2", "tool:k2", "assistant:a2", "divider:resumed", "user:u3", "assistant:a3", "turn_end:e3");
    expect(forkPoints(ids, items)).toEqual([
      [["a1"], "u1"],
      [["k2", "a2"], "u2"],
      [["a3", "e3"], "u3"],
    ]);
  });

  it("puts the button after the last part of a turn split by a notice", () => {
    const { ids, items } = transcript("user:u1", "assistant:a1", "notice:n1", "assistant:a2", "turn_end:e1", "user:u2", "assistant:a3");
    const groups = groupIds(ids, items);
    expect(groups.find((g) => g.ids.includes("a1"))?.forkFrom).toBeUndefined();
    expect(forkPoints(ids, items)).toEqual([
      [["a2", "e1"], "u1"],
      [["a3"], "u2"],
    ]);
  });

  it("offers none for a message that got no reply, or for agent items before any message", () => {
    const { ids, items } = transcript("notice:start", "assistant:orphan", "user:u1", "notice:failed", "user:u2", "assistant:a2");
    expect(forkPoints(ids, items)).toEqual([[["a2"], "u2"]]);
  });

  it("marks the running turn too (the button is disabled until it finishes)", () => {
    const { ids, items } = transcript("user:u1", "assistant:a1", "turn_end:e1", "user:u2", "thought:t2");
    expect(forkPoints(ids, items).map(([, from]) => from)).toEqual(["u1", "u2"]);
  });

  it("skips ids it has no item for", () => {
    const { ids, items } = transcript("user:u1", "assistant:a1");
    expect(forkPoints(["gone", ...ids, "gone-too"], items)).toEqual([[["a1"], "u1"]]);
  });
});
