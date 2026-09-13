/**
 * The APP — a thin shell over three surfaces: the CHANNEL (the org's
 * one stream), THREADS (each a task: its agent conversation + state
 * pane + reviews + workspace terminals), and the sidebar directory.
 * Visited views stay mounted; the channel stream is one socket for the
 * whole app.
 */

import { AppHeader } from "@/components/app-header";
import { BoardPage } from "@/components/board";
import { ChannelView, ThreadList } from "@/components/channel";
import { confirm, Confirmer } from "@/components/confirm";
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
  workspacePath,
  threadPath,
  type Route,
  type ThreadTab,
} from "@/lib/routes";
import { cn } from "@/lib/utils";
import { NotificationRow } from "@/components/notification";
import { useCallback, useEffect, useMemo, useState } from "react";

const BELL_SEEN_KEY = "alchemy-org:bell-seen";

/* ── one mounted thread ───────────────────────────────────────────── */

const ThreadPage = ({
  id,
  tab,
  active,
  onTab,
  deleting,
  onDeleteThread,
}: {
  id: string;
  tab: ThreadTab;
  active: boolean;
  onTab: (tab: ThreadTab) => void;
  /** The thread's DELETE is in flight. */
  deleting: boolean;
  /** The pane's "Delete thread" — the shell confirms and erases. */
  onDeleteThread: () => void;
}) => {
  const { state, missing } = useThreadState<ThreadState>(id);
  const onCloseThread = useCallback(() => {
    void fetch(`/api/threads/${encodeURIComponent(id)}/close`, {
      method: "POST",
    });
  }, [id]);
  const onReopenThread = useCallback(() => {
    void fetch(`/api/threads/${encodeURIComponent(id)}/reopen`, {
      method: "POST",
    });
  }, [id]);
  return (
    <ThreadView
      id={id}
      state={state}
      missing={missing}
      tab={tab}
      active={active}
      onTab={onTab}
      onCloseThread={onCloseThread}
      onReopenThread={onReopenThread}
      deleting={deleting}
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

  const openThread = useCallback((id: string) => {
    navigate(threadPath(id));
  }, []);

  // DELETE threads — one from its pane, one or a selection from the
  // sidebar's menu. Destructive and unrecoverable (the transcript, the
  // subagents, the workspaces with their machines), so one confirm
  // stands between the click and the erase. Afterwards each page is
  // forgotten (its sockets close with it) and a view that was ON a
  // deleted thread falls back to the channel.
  // threads whose DELETE is in flight — the server tears down agents
  // and workspaces before it answers, and the row stays in the
  // directory until then; these render as "deleting"
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const removeThreads = useCallback(
    (requested: ReadonlyArray<string>) => {
      const ids = requested.filter((id) => !deleting.has(id));
      if (ids.length === 0) return;
      const nameOf = (id: string) =>
        directory.find((row) => row.id === id)?.name ?? id;
      const what =
        ids.length === 1
          ? `thread "${nameOf(ids[0]!)}"? Its`
          : `${ids.length} threads (${ids.map(nameOf).join(", ")})? Their`;
      void confirm(
        `Delete ${what} conversation, subagents, and machine are erased. The channel keeps its messages.`,
      ).then((confirmed) => {
        if (!confirmed) return;
        setDeleting((current) => new Set([...current, ...ids]));
        const done = (id: string) =>
          setDeleting((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        for (const id of ids) {
          void deleteThread(id)
            .then(
              (response) => response.ok,
              () => false,
            )
            .then((ok) => {
              done(id);
              if (!ok) return;
              setVisited((current) => current.filter((entry) => entry !== id));
              if (route.kind === "thread" && route.id === id) {
                navigate(pathOf({ kind: "channel" }));
              }
            });
        }
      });
    },
    [deleting, directory, route],
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
  // the mark as it stood when the bell opened — the rows that were new
  // at that moment stay marked while it is up
  const [seenAtOpen, setSeenAtOpen] = useState(bellSeen);
  const onBellOpen = useCallback(
    (open: boolean) => {
      setBellOpen(open);
      if (open && cards.length > 0) {
        const latest = cards[0]!.seq;
        setSeenAtOpen(bellSeen);
        setBellSeen(latest);
        try {
          localStorage.setItem(BELL_SEEN_KEY, String(latest));
        } catch {
          // storage disabled — the badge just stays optimistic
        }
      }
    },
    [cards, bellSeen],
  );

  // jump to a card in the channel: go home, then the channel view
  // scrolls to the row and flashes it (the nonce re-fires a repeat
  // jump to the same card)
  const [focus, setFocus] = useState<
    { seq: number; nonce: number } | undefined
  >(undefined);
  const jumpToCard = useCallback((seq: number) => {
    setBellOpen(false);
    navigate(pathOf({ kind: "channel" }));
    setFocus((current) => ({ seq, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);
  const notificationActions = useMemo(
    () => ({
      onJumpToCard: jumpToCard,
      onOpenThread: (id: string) => {
        setBellOpen(false);
        openThread(id);
      },
      onOpenReview: (
        thread: string,
        owner: string,
        repo: string,
        number: number,
      ) => {
        setBellOpen(false);
        openReview(thread, owner, repo, number);
      },
    }),
    [jumpToCard, openThread, openReview],
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
              <NotificationRow
                key={message.id}
                message={message}
                threadName={
                  directory.find((row) => row.id === message.card.thread)
                    ?.name ??
                  message.card.thread ??
                  "channel"
                }
                // "new" is judged against the seen mark the bell had when
                // it opened — the mark moves on open, the dots stay for
                // this look
                unseen={message.seq > seenAtOpen}
                actions={notificationActions}
              />
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
            boardSelected={route.kind !== "thread"}
            onOpenBoard={() => navigate(pathOf({ kind: "channel" }))}
            onOpenThread={openThread}
            deleting={deleting}
            onDeleteThreads={removeThreads}
          />
        </Rail>
        <main className="relative flex min-w-0 flex-1 flex-col">
          {/* HOME — the board, the Control chat right of Done, and
              the events strip beyond it; always mounted (sockets and
              scroll survive thread visits) */}
          <div
            className={cn(
              "flex min-h-0 flex-1",
              route.kind === "thread" && "hidden",
            )}
          >
            <BoardPage onOpenThread={openThread} />
            <Rail
              label="Control"
              side="right"
              storageKey="control-rail-width"
              defaultWidth={440}
              minWidth={340}
              className="bg-background"
            >
              <ChannelView
                messages={messages}
                directory={directory}
                live={live}
                active={route.kind !== "thread"}
                focus={focus}
                onOpenThread={openThread}
                onOpenReview={openReview}
              />
            </Rail>
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
                  onTab={(tab) => {
                    setTabs((current) => ({ ...current, [id]: tab }));
                    navigate(
                      tab.kind === "chat"
                        ? threadPath(id)
                        : tab.kind === "review"
                          ? reviewPath(id, tab.owner, tab.repo, tab.number)
                          : tab.kind === "agent"
                            ? agentPath(id, tab.key)
                            : workspacePath(id, tab.name),
                    );
                  }}
                  deleting={deleting.has(id)}
                  onDeleteThread={() => removeThreads([id])}
                />
              </div>
            );
          })}
        </main>
      </div>
      {/* the app's confirm — in-page, because window.confirm renders
          nowhere the app doesn't */}
      <Confirmer />
    </div>
  );
};
