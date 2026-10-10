import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { findPendingPermission, getState, subscribe, useSelector, type StoreState } from "../store";
import { ItemView } from "./items/ItemView";
import { respondToPermission } from "./items/Permission";
import { Icon, IconButton, prefersReducedMotion } from "./ui";
import { Welcome } from "./Welcome";
import { post } from "../vscode";
import { groupIds } from "../turnGroups";

function TurnActions({ userItemId }: { userItemId: string }) {
  // Only a finished turn can be forked: mid-turn, Cursor has not saved where it ends.
  const canFork = useSelector((s) => !!s.session.sessionId && s.session.connection === "ready");
  return (
    <div class="turn-actions">
      <IconButton
        icon="repo-forked"
        label={canFork ? "Fork from here: a new chat with the conversation up to this reply" : "Fork from here (once the turn has finished)"}
        disabled={!canFork}
        onClick={() => post({ type: "session.fork", userItemId })}
      />
    </div>
  );
}

const BOTTOM_THRESHOLD = 48;

/** The last item in the transcript (its object identity changes on every append/upsert). */
function tailOf(s: StoreState) {
  return s.items.get(s.ids[s.ids.length - 1] ?? "");
}

export function Transcript() {
  const ids = useSelector((s) => s.ids);
  const resetSeq = useSelector((s) => s.resetSeq);
  const ready = useSelector((s) => s.ready);
  const groups = useMemo(() => groupIds(ids, getState().items), [ids]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showPill, setShowPill] = useState(false);

  const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: behavior === "smooth" && prefersReducedMotion() ? "auto" : behavior });
    atBottomRef.current = true;
    setShowPill(false);
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD;
    atBottomRef.current = atBottom;
    if (atBottom) setShowPill(false);
  };

  // Follow content growth while pinned to the bottom.
  useEffect(() => {
    const content = contentRef.current;
    const el = scrollRef.current;
    if (!content || !el) return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // "New messages" only when the tail of the transcript changes while the user
  // is scrolled up. Expanding a card above the fold grows the content too, but
  // that is not news. Subscribed directly so the list itself never re-renders.
  useEffect(() => {
    let lastTail = tailOf(getState());
    return subscribe(() => {
      const tail = tailOf(getState());
      if (tail === lastTail) return;
      lastTail = tail;
      if (!atBottomRef.current) setShowPill(true);
    });
  }, []);

  // Jump to the bottom after a full reload and after the user sends a prompt.
  useLayoutEffect(() => {
    scrollToBottom();
  }, [resetSeq, ready]);
  useEffect(() => {
    const lastId = ids[ids.length - 1];
    const last = lastId ? getState().items.get(lastId) : undefined;
    if (last && last.type === "user" && !last.replay) scrollToBottom("smooth");
  }, [ids]);

  // Keyboard shortcuts for a pending permission when focus is not in an input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || t?.isContentEditable) return;
      if (t?.closest(".popover")) return;
      const pending = findPendingPermission();
      if (!pending) return;
      const perm = pending.options.permission;
      if (!perm) return;
      let handled = false;
      switch (e.key) {
        case "y":
        case "Y":
          handled = respondToPermission(perm, "allow_once");
          break;
        case "s":
        case "S":
          handled = respondToPermission(perm, "allow_once", "session");
          break;
        case "Enter":
          if (tag === "BUTTON") return; // let the focused button's click fire
          handled = respondToPermission(perm, "allow_once");
          break;
        case "a":
        case "A":
          handled = respondToPermission(perm, "allow_always");
          break;
        case "n":
        case "N":
        case "Escape":
          handled = respondToPermission(perm, "reject_once");
          break;
      }
      if (handled) e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const empty = ids.length === 0;

  return (
    <div class="transcript-wrap">
      <div ref={scrollRef} class="transcript" role="log" aria-live="polite" aria-relevant="additions text" onScroll={onScroll} tabIndex={0}>
        <div ref={contentRef} class="transcript-content">
          {empty ? (
            <Welcome />
          ) : (
            groups.map((g) =>
              g.kind === "agent" ? (
                <div key={g.key} class="turn agent-turn">
                  <div class="turn-gutter" aria-hidden="true">
                    <span class="turn-avatar">
                      <Icon name="sparkle" />
                    </span>
                    <span class="turn-rule" />
                  </div>
                  <div class="turn-body">
                    {g.ids.map((id) => (
                      <ItemView key={id} id={id} />
                    ))}
                    {g.forkFrom && <TurnActions userItemId={g.forkFrom} />}
                  </div>
                </div>
              ) : (
                <div key={g.key} class={`turn ${g.kind}-turn`}>
                  {g.ids.map((id) => (
                    <ItemView key={id} id={id} />
                  ))}
                </div>
              ),
            )
          )}
        </div>
      </div>
      {showPill && !empty && (
        <button title="Scroll to the latest message" type="button" class="new-messages-pill" onClick={() => scrollToBottom("smooth")}>
          <Icon name="arrow-down" /> New messages
        </button>
      )}
    </div>
  );
}
