/**
 * The CHANNEL — the org's one stream: world events as timeline rows,
 * the operator's control messages (each with its collapsed run),
 * agent replies, and cards from threads. Full-width, chronological,
 * a composer at the bottom. The data arrives streamed (lib/cursor.ts);
 * this component only draws.
 */

import {
  AtTooltip,
  authorAvatarUrl,
  ChatView,
  dayOf,
  eventFamilyOf,
  formatAt,
  formatDay,
  MarkdownText,
} from "@/components/chat";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Rail } from "@/components/rail";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { ChannelMessage, ThreadDirectoryRow } from "@/lib/channel";
import { deleteChannelMessages, postChannel } from "@/lib/channel";
import { onRowMouseDown, skipRowClick, useSelection } from "@/lib/selection";
import { cn } from "@/lib/utils";
import {
  ArrowUp,
  ChevronDown,
  Copy,
  CornerUpLeft,
  FileDiff,
  MessageCircle,
  Reply,
  SquareArrowOutUpRight,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { AlchemyMark } from "@/components/app-header";

/* ── replies ──────────────────────────────────────────────────────── */

/** Who a message reads as — for quoting it. */
const whoOf = (message: ChannelMessage): string =>
  message.author?.login ??
  (message.kind === "agent"
    ? "channel"
    : message.kind === "card"
      ? message.card?.title ?? "card"
      : "event");

/** One line of a message, for a quote. */
const excerptOf = (text: string): string => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
};

/** The quoted originals above a reply — each jumps to its message;
 *  a deleted original says so. */
const ReplyQuotes = ({
  ids,
  byId,
  onJump,
}: {
  ids: ReadonlyArray<string>;
  byId: ReadonlyMap<string, ChannelMessage>;
  onJump: (seq: number) => void;
}) => (
  <div className="mb-0.5 flex flex-col gap-0.5">
    {ids.map((id) => {
      const original = byId.get(id);
      return (
        <button
          key={id}
          type="button"
          disabled={original === undefined}
          onClick={() => original !== undefined && onJump(original.seq)}
          title={original === undefined ? undefined : "Jump to the message"}
          className="flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground"
        >
          <CornerUpLeft className="size-3 shrink-0" />
          {original === undefined ? (
            <span className="italic">original message deleted</span>
          ) : (
            <>
              <span className="shrink-0 font-medium">{whoOf(original)}</span>
              <span className="min-w-0 truncate">
                {excerptOf(original.text)}
              </span>
            </>
          )}
        </button>
      );
    })}
  </div>
);

/* ── rows ─────────────────────────────────────────────────────────── */

/** The time gutter every row shares. */
const Gutter = ({ at }: { at: number }) => (
  <div className="w-12 shrink-0 select-none pt-0.5 text-right font-mono text-[10px] leading-4 text-muted-foreground/60">
    <AtTooltip at={at}>
      <span className="cursor-default hover:text-foreground">
        {formatAt(at)}
      </span>
    </AtTooltip>
  </div>
);

/** A thread tag on a row — where the message was placed. */
const ThreadChip = ({
  thread,
  directory,
  onOpenThread,
}: {
  thread: string;
  directory: ReadonlyArray<ThreadDirectoryRow>;
  onOpenThread: (id: string) => void;
}) => {
  const row = directory.find((entry) => entry.id === thread);
  return (
    <button
      type="button"
      onClick={() => onOpenThread(thread)}
      title={row?.title ?? thread}
      className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <MessageCircle className="size-3" />
      {row?.name ?? thread}
    </button>
  );
};

/** An event from the outside world: one line, family icon, markdown. */
const EventRow = memo(
  ({
    message,
    directory,
    onOpenThread,
  }: {
    message: ChannelMessage;
    directory: ReadonlyArray<ThreadDirectoryRow>;
    onOpenThread: (id: string) => void;
  }) => {
    const family = eventFamilyOf(message.event ?? "");
    const FamilyIcon = family.icon;
    return (
      <div className="flex items-start gap-2 px-1 py-0.5 text-[13px]">
        <Gutter at={message.at} />
        <FamilyIcon
          className={cn("mt-1 size-3.5 shrink-0", family.className)}
        />
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
          {message.author !== undefined && (
            <span className="shrink-0 font-medium text-foreground">
              {message.author.login}
            </span>
          )}
          <span className="min-w-0 text-muted-foreground [&_p]:m-0 [&_p]:inline">
            <MarkdownText text={message.text} repo={message.repo} />
          </span>
          {message.thread !== undefined && (
            <ThreadChip
              thread={message.thread}
              directory={directory}
              onOpenThread={onOpenThread}
            />
          )}
        </div>
      </div>
    );
  },
);
EventRow.displayName = "EventRow";

/** The operator speaking — avatar, name, text, and the RUN it
 *  triggered, behind a pill. While the agent is answering the pill
 *  pulses ("working"); either way clicking it opens the run's own
 *  session in the right-hand rail — the exploration happens THERE,
 *  never in the channel stream. */
const UserRow = memo(
  ({
    message,
    working,
    runOpen,
    onToggleRun,
    quotes,
  }: {
    message: ChannelMessage;
    working: boolean;
    runOpen: boolean;
    onToggleRun: () => void;
    /** The originals this message replies to, rendered above it. */
    quotes?: ReactNode;
  }) => {
    const login = message.author?.login;
    return (
      <div className="flex items-start gap-2 px-1 py-1.5">
        <Gutter at={message.at} />
        <Avatar className="mt-0.5 size-6 shrink-0 border border-border">
          {login !== undefined && (
            <AvatarImage src={authorAvatarUrl(login)} alt="" />
          )}
          <AvatarFallback className="text-[10px]">
            {(login ?? "you").slice(0, 2)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          {quotes}
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-semibold">
              {login ?? "you"}
            </span>
            <button
              type="button"
              onClick={onToggleRun}
              className={cn(
                "inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0 text-[11px]",
                runOpen
                  ? "border-primary/50 bg-accent text-foreground"
                  : working
                    ? "border-moss/40 bg-moss/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              title={
                working
                  ? "The channel agent is answering — click to watch"
                  : "The channel agent's run on this message"
              }
            >
              {working && (
                <span className="size-1.5 animate-pulse rounded-full bg-moss" />
              )}
              {working ? "working" : "ran"}
              <ChevronDown
                className={cn(
                  "size-3 transition-transform",
                  !runOpen && "-rotate-90",
                )}
              />
            </button>
          </div>
          <div className="text-[13px]">
            <MarkdownText text={message.text} />
          </div>
        </div>
      </div>
    );
  },
);
UserRow.displayName = "UserRow";

/** The channel agent answering. */
const AgentRow = memo(({ message }: { message: ChannelMessage }) => (
  <div className="flex items-start gap-2 px-1 py-1.5">
    <Gutter at={message.at} />
    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted/40">
      <AlchemyMark className="size-3.5" />
    </span>
    <div className="min-w-0 flex-1">
      <div className="text-[13px] font-semibold">channel</div>
      <div className="text-[13px]">
        <MarkdownText text={message.text} />
      </div>
    </div>
  </div>
));
AgentRow.displayName = "AgentRow";

/** A CARD — a thread reaching the control plane with a notification.
 *  Click the header to jump to the thread (or its review when the
 *  card names one). */
const CardRow = memo(
  ({
    message,
    directory,
    onOpenThread,
    onOpenReview,
  }: {
    message: ChannelMessage;
    directory: ReadonlyArray<ThreadDirectoryRow>;
    onOpenThread: (id: string) => void;
    onOpenReview: (
      thread: string,
      owner: string,
      repo: string,
      number: number,
    ) => void;
  }) => {
    const card = message.card!;
    const row = directory.find((entry) => entry.id === card.thread);

    return (
      <div className="flex items-start gap-2 px-1 py-1.5">
        <Gutter at={message.at} />
        <div className="min-w-0 flex-1 rounded-lg border border-border bg-card shadow-xs">
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
            <button
              type="button"
              onClick={() =>
                card.review !== undefined
                  ? onOpenReview(
                      card.thread,
                      card.review.owner,
                      card.review.repo,
                      card.review.number,
                    )
                  : onOpenThread(card.thread)
              }
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
              title={
                card.review !== undefined
                  ? "Open the review"
                  : "Open the thread"
              }
            >
              {card.review !== undefined ? (
                <FileDiff className="size-3.5 shrink-0 text-mist" />
              ) : (
                <MessageCircle className="size-3.5 shrink-0 text-mist" />
              )}
              <span className="truncate text-[13px] font-medium hover:underline">
                {card.title}
              </span>
            </button>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {row?.name ?? card.thread}
            </span>
          </div>
          <div className="px-3 py-2 text-[13px]">
            <MarkdownText text={message.text} repo={message.repo} />
          </div>
        </div>
      </div>
    );
  },
);
CardRow.displayName = "CardRow";

/** Confirm, then delete — the DO broadcasts the removal so the rows
 *  vanish from every open view at once. Deferred a tick so the menu
 *  that asked has closed before the confirm blocks. */
const confirmDeleteMessages = (ids: ReadonlyArray<string>) => {
  if (ids.length === 0) return;
  setTimeout(() => {
    if (
      window.confirm(
        ids.length === 1
          ? "Delete this message from the channel?"
          : `Delete ${ids.length} messages from the channel?`,
      )
    ) {
      void deleteChannelMessages(ids);
    }
  }, 0);
};

/** Put the messages' text on the clipboard, blank-line separated. */
const copyText = (texts: ReadonlyArray<string>) => {
  void navigator.clipboard?.writeText(texts.join("\n\n")).catch(() => {});
};

/* ── the view ─────────────────────────────────────────────────────── */

export const ChannelView = ({
  messages,
  directory,
  live,
  active,
  onOpenThread,
  onOpenReview,
}: {
  messages: ReadonlyArray<ChannelMessage>;
  directory: ReadonlyArray<ThreadDirectoryRow>;
  live: boolean;
  active: boolean;
  onOpenThread: (id: string) => void;
  onOpenReview: (
    thread: string,
    owner: string,
    repo: string,
    number: number,
  ) => void;
}) => {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // the run rail: the seq of the user message whose run is open
  const [runSeq, setRunSeq] = useState<number | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // SELECTION over the stream (click / ⌘ / ⇧), the ids the open
  // context menu acts on, and the inline reply being composed
  const order = useMemo(() => messages.map((message) => message.id), [messages]);
  const byId = useMemo(
    () => new Map(messages.map((message) => [message.id, message] as const)),
    [messages],
  );
  const selection = useSelection(order, { onDelete: confirmDeleteMessages });
  const [menuIds, setMenuIds] = useState<ReadonlyArray<string>>([]);
  const [replyTo, setReplyTo] = useState<ReadonlyArray<string>>([]);
  // a reply's originals that were deleted meanwhile drop out of it
  useEffect(() => {
    setReplyTo((current) => {
      const alive = current.filter((id) => byId.has(id));
      return alive.length === current.length ? current : alive;
    });
  }, [byId]);
  const startReply = useCallback((ids: ReadonlyArray<string>) => {
    setReplyTo(ids);
    selection.clear();
    // the next frame — the menu is still closing on this one
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [selection]);

  // jump to a quoted message: scroll it into view and flash it
  const [flash, setFlash] = useState<number | undefined>(undefined);
  const jumpTo = useCallback((seq: number) => {
    scrollRef.current
      ?.querySelector(`[data-seq="${seq}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlash(seq);
    setTimeout(() => setFlash((current) => (current === seq ? undefined : current)), 1500);
  }, []);

  // stick to the bottom while the user is there; never yank them up
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null || !stickRef.current) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (active) textareaRef.current?.focus();
  }, [active]);

  // a user message's run is WORKING until the agent's reply lands —
  // every run ends with exactly one agent row (Routes.ts falls back to
  // the run's final text), so "no agent message after mine" is the
  // in-flight signal
  const lastAnswered = useMemo(() => {
    let last = 0;
    for (const message of messages) {
      if (message.kind === "agent" && message.seq > last) last = message.seq;
    }
    return last;
  }, [messages]);

  const rows = useMemo(() => {
    const out: ReactNode[] = [];
    let lastDay: string | undefined;
    for (const message of messages) {
      const day = dayOf(message.at);
      if (day !== undefined && day !== lastDay) {
        lastDay = day;
        out.push(
          <div key={`day-${message.seq}`} className="flex items-center gap-3 py-1">
            <div className="h-px flex-1 bg-border" />
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {formatDay(message.at)}
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>,
        );
      }
      // every row is SELECTABLE (click, ⌘-click, ⇧-click) and carries
      // the context menu; the menu acts on the selection it lands in
      const selected = selection.has(message.id);
      const wrap = (node: ReactNode) => (
        <div
          key={message.seq}
          data-seq={message.seq}
          data-message-id={message.id}
          data-selected={selected ? "" : undefined}
          onMouseDown={onRowMouseDown}
          onClick={(event: MouseEvent) => {
            if (!skipRowClick(event)) selection.click(message.id, event);
          }}
          onContextMenu={() => setMenuIds(selection.target(message.id))}
          className={cn(
            "-mx-2 rounded-md border-l-2 border-transparent px-1.5 transition-colors",
            selected && "border-primary/60 bg-accent/60",
            flash === message.seq && "bg-primary/15",
          )}
        >
          {node}
        </div>
      );
      switch (message.kind) {
        case "event":
          out.push(
            wrap(
              <EventRow
                message={message}
                directory={directory}
                onOpenThread={onOpenThread}
              />,
            ),
          );
          break;
        case "user":
          out.push(
            wrap(
              <UserRow
                message={message}
                working={live && message.seq > lastAnswered}
                runOpen={runSeq === message.seq}
                onToggleRun={() =>
                  setRunSeq((current) =>
                    current === message.seq ? undefined : message.seq,
                  )
                }
                quotes={
                  message.replyTo !== undefined &&
                  message.replyTo.length > 0 ? (
                    <ReplyQuotes
                      ids={message.replyTo}
                      byId={byId}
                      onJump={jumpTo}
                    />
                  ) : undefined
                }
              />,
            ),
          );
          break;
        case "agent":
          out.push(wrap(<AgentRow message={message} />));
          break;
        case "card":
          out.push(
            wrap(
              <CardRow
                message={message}
                directory={directory}
                onOpenThread={onOpenThread}
                onOpenReview={onOpenReview}
              />,
            ),
          );
          break;
      }
    }
    return out;
  }, [
    messages,
    directory,
    live,
    lastAnswered,
    runSeq,
    onOpenThread,
    onOpenReview,
    selection,
    byId,
    flash,
    jumpTo,
  ]);

  const send = () => {
    const text = draft.trim();
    if (text.length === 0 || sending) return;
    setSending(true);
    void postChannel(text, replyTo)
      .then((response) => {
        if (response.ok) {
          setDraft("");
          setReplyTo([]);
        }
      })
      .finally(() => setSending(false));
  };

  const many = menuIds.length > 1 ? `${menuIds.length} messages` : undefined;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const target = event.currentTarget;
            stickRef.current =
              target.scrollHeight - target.scrollTop - target.clientHeight <
              80;
          }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {/* ONE menu for the stream; the row under the pointer picks
              the ids (its own, or the selection it belongs to) */}
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                onContextMenu={(event) => {
                  // off a row there is nothing to act on — no menu
                  if (
                    !(event.target instanceof Element) ||
                    event.target.closest("[data-seq]") === null
                  ) {
                    event.preventDefault();
                  }
                }}
                className="mx-auto flex max-w-4xl flex-col px-4 py-4"
              >
                {rows.length === 0 && (
                  <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
                    {live ? (
                      <>
                        <AlchemyMark className="size-8 opacity-40" />
                        <span className="text-sm">
                          The channel is empty — events land here as they
                          happen.
                        </span>
                      </>
                    ) : (
                      <Spinner className="size-5" />
                    )}
                  </div>
                )}
                {rows}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => startReply(menuIds)}>
                <Reply />
                {many === undefined ? "Reply" : `Reply to ${many}`}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() =>
                  copyText(menuIds.map((id) => byId.get(id)?.text ?? ""))
                }
              >
                <Copy />
                Copy text
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                onSelect={() => confirmDeleteMessages(menuIds)}
              >
                <Trash2 />
                {many === undefined ? "Delete" : `Delete ${many}`}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </div>
        <div className="mx-auto w-full max-w-4xl px-4 pb-4">
          <div className="relative rounded-lg border border-border bg-card shadow-xs focus-within:ring-1 focus-within:ring-ring">
            {/* the reply bar — what the message will answer */}
            {replyTo.length > 0 && (
              <div
                aria-label="Replying to"
                className="flex flex-col gap-0.5 border-b border-border px-3 py-1.5"
              >
                {replyTo.map((id) => {
                  const original = byId.get(id)!;
                  return (
                    <div
                      key={id}
                      className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                    >
                      <CornerUpLeft className="size-3 shrink-0" />
                      <span className="shrink-0">
                        Replying to{" "}
                        <span className="font-medium text-foreground">
                          {whoOf(original)}
                        </span>
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {excerptOf(original.text)}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setReplyTo((current) =>
                            current.filter((entry) => entry !== id),
                          )
                        }
                        aria-label={`Stop replying to ${whoOf(original)}`}
                        className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <Textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                } else if (event.key === "Escape" && replyTo.length > 0) {
                  event.preventDefault();
                  setReplyTo([]);
                }
              }}
              placeholder={
                replyTo.length > 0
                  ? "Reply…"
                  : "Message the channel — the agent routes, you decide…"
              }
              aria-label="Message the channel"
              className="min-h-12 resize-none border-0 bg-transparent pr-12 shadow-none focus-visible:ring-0"
            />
            <Button
              size="icon"
              variant="ghost"
              disabled={draft.trim().length === 0 || sending}
              onClick={send}
              aria-label="Send"
              className="absolute right-2 bottom-2 size-7 text-muted-foreground"
            >
              {sending ? (
                <Spinner className="size-4" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </Button>
          </div>
        </div>
      </div>
      {/* the run rail — the agent's session on one message, beside the
          stream (the exploration never streams into the channel) */}
      {runSeq !== undefined && (
        <Rail
          label="Run"
          side="right"
          storageKey="run-rail-width"
          defaultWidth={480}
          minWidth={360}
          className="bg-background"
        >
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
              The agent's run
            </span>
            <button
              type="button"
              onClick={() => setRunSeq(undefined)}
              aria-label="Close the run pane"
              className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <ChatView
              key={runSeq}
              id={`Channel:main@${runSeq}`}
              active={false}
              readOnly
              hideFinalReply
            />
          </div>
        </Rail>
      )}
    </div>
  );
};

/* ── the rail (thread list) ───────────────────────────────────────── */

const TURN_LABEL: Record<string, string> = {
  you: "Your turn",
  agents: "Agents working",
  others: "Waiting on others",
  idle: "Idle",
};

const TURN_DOT: Record<string, string> = {
  you: "bg-terracotta",
  agents: "bg-moss animate-pulse",
  others: "bg-mist",
  idle: "bg-muted-foreground/40",
};

/** The sidebar: `#channel` on top, then open threads grouped by turn. */
export const ThreadList = ({
  directory,
  selected,
  channelSelected,
  onOpenChannel,
  onOpenThread,
  onDeleteThreads,
}: {
  directory: ReadonlyArray<ThreadDirectoryRow>;
  selected: string | undefined;
  channelSelected: boolean;
  onOpenChannel: () => void;
  onOpenThread: (id: string) => void;
  /** The menu's delete (one thread or a selection) — the shell
   *  confirms and erases. */
  onDeleteThreads: (ids: ReadonlyArray<string>) => void;
}) => {
  const groups = useMemo(() => {
    const open = directory.filter((row) => row.status === "open");
    const closed = directory.filter((row) => row.status === "closed");
    const byTurn = (turn: string) =>
      open
        .filter((row) => row.turn === turn)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    return [
      ["you", byTurn("you")] as const,
      ["agents", byTurn("agents")] as const,
      ["others", byTurn("others")] as const,
      ["idle", byTurn("idle")] as const,
      ["closed", closed.sort((a, b) => b.updatedAt - a.updatedAt)] as const,
    ].filter(([, rows]) => rows.length > 0);
  }, [directory]);

  // SELECTION over the rows as listed (⌘/⇧-click select without
  // opening; a plain click opens AND selects) and the context menu
  const order = useMemo(
    () => groups.flatMap(([, rows]) => rows.map((row) => row.id)),
    [groups],
  );
  const pick = useSelection(order, { onDelete: onDeleteThreads });
  const [menuIds, setMenuIds] = useState<ReadonlyArray<string>>([]);
  const many =
    menuIds.length > 1 ? `${menuIds.length} threads` : undefined;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
    <nav
      aria-label="Threads"
      onContextMenu={(event) => {
        // off a row there is nothing to act on — no menu
        if (
          !(event.target instanceof Element) ||
          event.target.closest("[data-thread]") === null
        ) {
          event.preventDefault();
        }
      }}
      className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2"
    >
      <button
        type="button"
        onClick={onOpenChannel}
        aria-current={channelSelected ? "page" : undefined}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
          channelSelected
            ? "bg-accent font-medium text-foreground"
            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        )}
      >
        <Terminal className="size-4 shrink-0" />
        <span className="truncate"># channel</span>
      </button>
      {groups.map(([turn, rows]) => (
        <div key={turn} className="mt-2 flex flex-col gap-0.5">
          <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            {turn === "closed" ? "Closed" : TURN_LABEL[turn]}
          </div>
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              data-thread={row.id}
              data-selected={pick.has(row.id) ? "" : undefined}
              onClick={(event) => {
                if (!pick.click(row.id, event)) onOpenThread(row.id);
              }}
              onContextMenu={() => setMenuIds(pick.target(row.id))}
              aria-current={selected === row.id ? "page" : undefined}
              title={row.title}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                selected === row.id
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                pick.has(row.id) && "bg-primary/10 text-foreground",
                turn === "closed" && "opacity-60",
              )}
            >
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  turn === "closed"
                    ? "bg-muted-foreground/30"
                    : TURN_DOT[row.turn],
                )}
              />
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
            </button>
          ))}
        </div>
      ))}
    </nav>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {menuIds.length === 1 && (
          <>
            <ContextMenuItem onSelect={() => onOpenThread(menuIds[0]!)}>
              <SquareArrowOutUpRight />
              Open
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem
          variant="destructive"
          // deferred a tick so the menu has closed before the confirm
          onSelect={() => setTimeout(() => onDeleteThreads(menuIds), 0)}
        >
          <Trash2 />
          {many === undefined ? "Delete thread" : `Delete ${many}`}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};
