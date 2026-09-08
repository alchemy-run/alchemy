/**
 * The APP — a thin shell over three surfaces: the CHANNEL (the org's
 * one stream), THREADS (each a task: its agent conversation + state
 * pane + reviews + terminals), and the sidebar directory. Visited
 * views stay mounted; the channel stream is one socket for the whole
 * app.
 */

import { AppHeader } from "@/components/app-header";
import { ChannelView, ThreadList } from "@/components/channel";
import { Rail } from "@/components/rail";
import { ThreadView } from "@/components/thread";
import { deleteThread, type ChannelMessage } from "@/lib/channel";
import { useChannelStream, useThreadState } from "@/lib/cursor";
import type { ThreadState } from "@/lib/channel";
import {
  agentPath,
  NAVIGATE_EVENT,
  navigate,
  pathOf,
  reviewPath,
  routeFromLocation,
  terminalPath,
  threadPath,
  type Route,
  type ThreadTab,
} from "@/lib/routes";
import { cn } from "@/lib/utils";
import { FileDiff, MessageCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

/* ── per-thread terminals (local, remembered) ─────────────────────── */

const TERMINALS_KEY = "alchemy-org:terminals";
const BELL_SEEN_KEY = "alchemy-org:bell-seen";

const readTerminals = (): Record<string, string[]> => {
  try {
    const raw = localStorage.getItem(TERMINALS_KEY);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, string[]>);
  } catch {
    return {};
  }
};

/* ── one mounted thread ───────────────────────────────────────────── */

const ThreadPage = ({
  id,
  tab,
  active,
  terminals,
  onTab,
  onNewTerminal,
  onCloseTerminal,
  onDeleteThread,
}: {
  id: string;
  tab: ThreadTab;
  active: boolean;
  terminals: ReadonlyArray<string>;
  onTab: (tab: ThreadTab) => void;
  onNewTerminal: () => void;
  onCloseTerminal: (pty: string) => void;
  /** The pane's "Delete thread" — the shell confirms and erases. */
  onDeleteThread: () => void;
}) => {
  const state = useThreadState<ThreadState>(id);
  const onCloseThread = useCallback(() => {
    void fetch(`/api/threads/${encodeURIComponent(id)}/close`, {
      method: "POST",
    });
  }, [id]);
  return (
    <ThreadView
      id={id}
      state={state}
      tab={tab}
      active={active}
      terminals={terminals}
      onTab={onTab}
      onNewTerminal={onNewTerminal}
      onCloseTerminal={onCloseTerminal}
      onCloseThread={onCloseThread}
      onDeleteThread={onDeleteThread}
    />
  );
};

/* ── the shell ────────────────────────────────────────────────────── */

export const App = () => {
  const [route, setRoute] = useState<Route>(() => routeFromLocation());
  const { messages, directory, live } = useChannelStream();

  // location ↔ state
  useEffect(() => {
    const read = () => setRoute(routeFromLocation());
    window.addEventListener("popstate", read);
    window.addEventListener(NAVIGATE_EVENT, read);
    return () => {
      window.removeEventListener("popstate", read);
      window.removeEventListener(NAVIGATE_EVENT, read);
    };
  }, []);

  // visited threads stay mounted (switching back is instant, scroll
  // and sockets kept); remember the tab each thread last showed
  const [visited, setVisited] = useState<ReadonlyArray<string>>([]);
  const [tabs, setTabs] = useState<Record<string, ThreadTab>>({});
  useEffect(() => {
    if (route.kind !== "thread") return;
    const { id, tab } = route;
    setVisited((current) =>
      current.includes(id) ? current : [...current, id],
    );
    setTabs((current) => ({ ...current, [id]: tab }));
  }, [route]);

  // terminals per thread — the operator's ptys, remembered locally
  const [terminals, setTerminals] =
    useState<Record<string, string[]>>(readTerminals);
  const rememberTerminals = (next: Record<string, string[]>) => {
    setTerminals(next);
    try {
      localStorage.setItem(TERMINALS_KEY, JSON.stringify(next));
    } catch {
      // storage disabled — the ptys still work, unremembered
    }
  };

  const openThread = useCallback((id: string) => {
    navigate(threadPath(id));
  }, []);

  // DELETE threads — one from its pane, one or a selection from the
  // sidebar's menu. Destructive and unrecoverable (the transcript, the
  // subagents, the machine), so one confirm stands between the click
  // and the erase. Afterwards each page is forgotten (its sockets
  // close with it), so are the ptys it opened (the machine is gone),
  // and a view that was ON a deleted thread falls back to the channel.
  const removeThreads = useCallback(
    (ids: ReadonlyArray<string>) => {
      if (ids.length === 0) return;
      const nameOf = (id: string) =>
        directory.find((row) => row.id === id)?.name ?? id;
      const what =
        ids.length === 1
          ? `thread "${nameOf(ids[0]!)}"? Its`
          : `${ids.length} threads (${ids.map(nameOf).join(", ")})? Their`;
      if (
        !window.confirm(
          `Delete ${what} conversation, subagents, and machine are erased. The channel keeps its messages.`,
        )
      ) {
        return;
      }
      for (const id of ids) {
        void deleteThread(id).then((response) => {
          if (!response.ok) return;
          setVisited((current) => current.filter((entry) => entry !== id));
          setTerminals((current) => {
            const { [id]: _dropped, ...rest } = current;
            try {
              localStorage.setItem(TERMINALS_KEY, JSON.stringify(rest));
            } catch {
              // storage disabled — nothing to forget
            }
            return rest;
          });
          if (route.kind === "thread" && route.id === id) {
            navigate(pathOf({ kind: "channel" }));
          }
        });
      }
    },
    [directory, route],
  );

  const openReview = useCallback(
    (thread: string, owner: string, repo: string, number: number) => {
      navigate(reviewPath(thread, owner, repo, number));
    },
    [],
  );

  // the bell: cards from threads, newest first; the badge counts the
  // ones that arrived since the bell was last opened
  const cards = useMemo(
    () =>
      messages
        .filter(
          (
            message,
          ): message is ChannelMessage & {
            card: NonNullable<ChannelMessage["card"]>;
          } => message.card !== undefined,
        )
        .slice(-20)
        .reverse(),
    [messages],
  );
  const [bellSeen, setBellSeen] = useState<number>(() => {
    const raw = localStorage.getItem(BELL_SEEN_KEY);
    const seq = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(seq) ? seq : 0;
  });
  const unseen = useMemo(
    () => cards.filter((message) => message.seq > bellSeen).length,
    [cards, bellSeen],
  );
  const [bellOpen, setBellOpen] = useState(false);
  const onBellOpen = useCallback(
    (open: boolean) => {
      setBellOpen(open);
      if (open && cards.length > 0) {
        const latest = cards[0]!.seq;
        setBellSeen(latest);
        try {
          localStorage.setItem(BELL_SEEN_KEY, String(latest));
        } catch {
          // storage disabled — the badge just stays optimistic
        }
      }
    },
    [cards],
  );

  const selectedThread = route.kind === "thread" ? route.id : undefined;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <AppHeader
        pending={unseen}
        notificationsOpen={bellOpen}
        onNotificationsOpen={onBellOpen}
        notifications={
          <div className="flex flex-col overflow-y-auto">
            {cards.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                Nothing yet — threads post cards here.
              </div>
            )}
            {cards.map((message) => (
              <button
                key={message.id}
                type="button"
                onClick={() => {
                  setBellOpen(false);
                  if (message.card.review !== undefined) {
                    openReview(
                      message.card.thread,
                      message.card.review.owner,
                      message.card.review.repo,
                      message.card.review.number,
                    );
                  } else {
                    openThread(message.card.thread);
                  }
                }}
                className="flex cursor-pointer items-start gap-2 border-b border-border/60 px-3 py-2 text-left hover:bg-accent/60"
              >
                {message.card.review !== undefined ? (
                  <FileDiff className="mt-0.5 size-3.5 shrink-0 text-mist" />
                ) : (
                  <MessageCircle className="mt-0.5 size-3.5 shrink-0 text-mist" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">
                    {message.card.title}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {message.text.split("\n")[0]}
                  </span>
                </span>
              </button>
            ))}
          </div>
        }
      />
      <div className="flex min-h-0 flex-1">
        <Rail
          label="Threads"
          side="left"
          storageKey="sidebar-width"
          defaultWidth={240}
          minWidth={180}
        >
          <ThreadList
            directory={directory}
            selected={selectedThread}
            channelSelected={route.kind === "channel"}
            onOpenChannel={() => navigate(pathOf({ kind: "channel" }))}
            onOpenThread={openThread}
            onDeleteThreads={removeThreads}
          />
        </Rail>
        <main className="relative flex min-w-0 flex-1 flex-col">
          {/* the channel — always mounted */}
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              route.kind !== "channel" && "hidden",
            )}
          >
            <ChannelView
              messages={messages}
              directory={directory}
              live={live}
              active={route.kind === "channel"}
              onOpenThread={openThread}
              onOpenReview={openReview}
            />
          </div>
          {/* visited threads stay mounted */}
          {visited.map((id) => {
            const activeThread = route.kind === "thread" && route.id === id;
            return (
              <div
                key={id}
                className={cn(
                  "flex min-h-0 flex-1 flex-col",
                  !activeThread && "hidden",
                )}
              >
                <ThreadPage
                  id={id}
                  tab={tabs[id] ?? { kind: "chat" }}
                  active={activeThread}
                  terminals={terminals[id] ?? []}
                  onTab={(tab) => {
                    setTabs((current) => ({ ...current, [id]: tab }));
                    navigate(
                      tab.kind === "chat"
                        ? threadPath(id)
                        : tab.kind === "review"
                          ? reviewPath(id, tab.owner, tab.repo, tab.number)
                          : tab.kind === "agent"
                            ? agentPath(id, tab.key)
                            : terminalPath(id, tab.pty),
                    );
                  }}
                  onNewTerminal={() => {
                    const pty = crypto.randomUUID().slice(0, 8);
                    rememberTerminals({
                      ...terminals,
                      [id]: [...(terminals[id] ?? []), pty],
                    });
                    setTabs((current) => ({
                      ...current,
                      [id]: { kind: "terminal", pty },
                    }));
                    navigate(terminalPath(id, pty));
                  }}
                  onCloseTerminal={(pty) => {
                    rememberTerminals({
                      ...terminals,
                      [id]: (terminals[id] ?? []).filter(
                        (entry) => entry !== pty,
                      ),
                    });
                    setTabs((current) => ({
                      ...current,
                      [id]: { kind: "chat" },
                    }));
                    navigate(threadPath(id));
                  }}
                  onDeleteThread={() => removeThreads([id])}
                />
              </div>
            );
          })}
        </main>
      </div>
    </div>
  );
};
