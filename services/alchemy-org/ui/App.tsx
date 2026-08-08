import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { RefHoverCard } from "@/components/ref-hover-card";
import { hasToolCard, ToolCard } from "@/components/tool-card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAnchoredToggle } from "@/lib/anchor";
import { cn } from "@/lib/utils";
import type { UIMessage } from "ai";
import { useAgent, useChat } from "alchemy/AI/React";
import {
  AlarmClock,
  CircleDot,
  GitMerge,
  GitPullRequestArrow,
  MessageSquare,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

interface BoardThread {
  id: string;
  term: string;
  key: string;
  status: "running" | "idle" | "settled" | "crashed";
  ticks: number;
  createdAt: number;
  updatedAt: number;
  firstInput?: string | null;
}

/** Every thread is one SESSION of the coder: `Coder:<key>`. */
const DEFAULT_THREAD = "Coder:main";

const threadFromHash = (): string => {
  const raw = decodeURIComponent(window.location.hash.slice(1));
  return raw.startsWith("Coder:") ? raw : DEFAULT_THREAD;
};

/** Short relative age for the sidebar; the tooltip has the full form. */
const timeAgo = (at: number): string => {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

const statusDot: Record<BoardThread["status"], string> = {
  running: "bg-emerald-500 animate-pulse",
  idle: "bg-muted-foreground/40",
  settled: "bg-muted-foreground/20",
  crashed: "bg-red-500",
};

/** A thread's sidebar title: its first message, else a placeholder. */
const threadTitle = (thread: BoardThread | undefined): string => {
  const first = thread?.firstInput?.trim();
  return first !== undefined && first !== null && first.length > 0
    ? first
    : "New thread";
};

export const App = () => {
  const [threads, setThreads] = useState<BoardThread[]>([]);
  const [activeId, setActiveId] = useState<string>(threadFromHash);
  // visited threads stay MOUNTED (visibility-hidden) so switching
  // back preserves scroll position and the streaming tail
  const [visited, setVisited] = useState<string[]>(() => [threadFromHash()]);

  const open = (id: string) => {
    window.location.hash = encodeURIComponent(id);
    setActiveId(id);
    setVisited((current) =>
      current.includes(id) ? current : [...current, id],
    );
  };

  // back/forward navigation drives the same path
  useEffect(() => {
    const onHash = () => {
      const id = threadFromHash();
      setActiveId(id);
      setVisited((current) =>
        current.includes(id) ? current : [...current, id],
      );
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // the board: poll — threads appear the moment their session is
  // admitted (opening a thread attaches, which admits)
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/chats")
        .then(
          (response) =>
            (response.ok ? response.json() : []) as Promise<BoardThread[]>,
        )
        .then((board) => {
          if (live) setThreads(board.filter((t) => t.term === "Coder"));
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  const newThread = () =>
    open(`Coder:t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`);

  // newest first; the active thread is listed even before the board
  // knows it (a just-created thread has no row yet)
  const list = useMemo(() => {
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    if (!byId.has(activeId)) {
      byId.set(activeId, {
        id: activeId,
        term: "Coder",
        key: activeId.slice("Coder:".length),
        status: "idle",
        ticks: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        firstInput: null,
      });
    }
    return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [threads, activeId]);

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="font-mono text-xs text-muted-foreground">
            threads
          </span>
          <button
            type="button"
            onClick={newThread}
            className="rounded border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            + new
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.map((thread) => (
            <button
              key={thread.id}
              type="button"
              onClick={() => open(thread.id)}
              className={cn(
                "flex w-full flex-col gap-1 border-b border-border/50 px-3 py-2 text-left hover:bg-accent/50",
                thread.id === activeId && "bg-accent",
              )}
            >
              <span className="truncate text-[13px] leading-tight">
                {threadTitle(thread)}
              </span>
              <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                <span
                  className={cn(
                    "inline-block size-1.5 rounded-full",
                    statusDot[thread.status] ?? statusDot.idle,
                  )}
                />
                {thread.status}
                <span className="ml-auto">
                  <AtTooltip at={thread.updatedAt}>
                    <span className="cursor-default">
                      {timeAgo(thread.updatedAt)}
                    </span>
                  </AtTooltip>
                </span>
              </span>
            </button>
          ))}
        </div>
      </aside>
      <main className="relative flex min-w-0 flex-1 flex-col">
        {visited.map((id) => (
          <div
            key={id}
            className={cn(
              "absolute inset-0 flex flex-col",
              id === activeId ? "visible" : "pointer-events-none invisible",
            )}
          >
            <ChatView
              id={id}
              active={id === activeId}
              agents={[]}
              breadcrumb={undefined}
              onOpenThread={open}
            />
          </div>
        ))}
      </main>
    </div>
  );
};


interface ChatContext {
  /** The channel's dispatched workers — dispatch cards link to them. */
  agents: BoardThread[];
  /** Set when this chat is itself a worker: the way back up. */
  breadcrumb: { label: string; to: string } | undefined;
  onOpenThread: (id: string) => void;
}

const ChatView = ({
  id,
  active,
  ...context
}: { id: string; active: boolean } & ChatContext) => {
  const [initial, setInitial] = useState<UIMessage[]>();

  // snapshot first; the live tail rides the run socket. Drop the
  // snapshot's in-flight `live-*` sample — the socket restates that
  // burst durably, and keeping both renders the reasoning twice (one
  // stuck on "Thinking…" forever).
  useEffect(() => {
    fetch(`/api/chats/${encodeURIComponent(id)}/messages`)
      .then(
        (response) =>
          (response.ok ? response.json() : []) as Promise<UIMessage[]>,
      )
      .then((messages) =>
        setInitial(messages.filter((m) => !m.id.startsWith("live-"))),
      )
      .catch(() => setInitial([]));
  }, [id]);

  if (initial === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }
  return <Chat id={id} initial={initial} active={active} {...context} />;
};

/** Full local timestamp, tooltip-grade: "Sun, Mar 1, 2026, 02:54:07". */
const formatFull = (at: number): string =>
  new Date(at).toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

/** A hover/click tooltip carrying the full timestamp. */
const AtTooltip = ({ at, children }: { at: number; children: ReactNode }) => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" className="font-mono text-xs">
        {formatFull(at)}
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
);

/** Compact time for the gutter — day context lives in the dividers. */
const formatAt = (at: number | undefined): string => {
  if (at === undefined || !Number.isFinite(at)) return "";
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

/** Calendar-day key for divider boundaries. */
const dayOf = (at: number | undefined): string | undefined =>
  at === undefined || !Number.isFinite(at)
    ? undefined
    : new Date(at).toDateString();

/** "Mar 1" (+ year when not this year) — the day-divider label. */
const formatDay = (at: number): string => {
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
};

/** GitHub event families → timeline icon + accent. */
const EVENT_FAMILY: Array<[RegExp, { icon: LucideIcon; className: string }]> = [
  [/^PullRequestMerged/, { icon: GitMerge, className: "text-terracotta" }],
  [/^PullRequest/, { icon: GitPullRequestArrow, className: "text-terracotta" }],
  [/^IssueComment/, { icon: MessageSquare, className: "text-mist" }],
  [/^Issue/, { icon: CircleDot, className: "text-moss" }],
  [
    /^(CheckRun|CheckSuite|WorkflowRun|Push)/,
    { icon: Zap, className: "text-honey" },
  ],
];

/** Humanized verb phrases for the common tags; the fallback spaces
 *  out the PascalCase (`ReviewRequested` → "review requested"). */
const EVENT_VERB: Record<string, string> = {
  IssueOpened: "opened issue",
  IssueClosed: "closed issue",
  IssueReopened: "reopened issue",
  IssueCommentCreated: "commented on",
  PullRequestOpened: "opened pull request",
  PullRequestMerged: "merged pull request",
  PullRequestClosed: "closed pull request",
  PullRequestReviewSubmitted: "reviewed",
};

const eventVerb = (tag: string): string =>
  EVENT_VERB[tag] ?? tag.replace(/(?<=[a-z0-9])(?=[A-Z])/g, " ").toLowerCase();

interface WorldEvent {
  tag: string;
  repo?: string;
  number?: number;
  title?: string;
  author?: string;
  body?: string;
  url?: string;
}

/** Best-effort parse of an input text as a tagged GitHub world event. */
const parseWorldEvent = (
  text: string,
): { event: WorldEvent; raw: string } | undefined => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, any>;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const tag = parsed._tag;
    if (typeof tag !== "string") return undefined;
    const repo = parsed.repository
      ? `${parsed.repository.owner?.login ?? ""}/${parsed.repository.name ?? ""}`
      : undefined;
    const subject = parsed.issue ?? parsed.pullRequest ?? parsed.pull_request;
    const comment = parsed.comment;
    // a COMMENT event's significant text is the comment itself, not
    // the issue it landed on — headline with its first line
    const commentLine =
      typeof comment?.body === "string"
        ? comment.body.trim().split("\n")[0]
        : undefined;
    return {
      event: {
        tag,
        repo,
        number: subject?.number,
        title: commentLine || subject?.title,
        author:
          comment?.user?.login ?? subject?.user?.login ?? parsed.sender?.login,
        body: comment?.body ?? subject?.body ?? undefined,
        url: comment?.html_url ?? subject?.html_url,
      },
      raw: JSON.stringify(parsed, null, 2),
    };
  } catch {
    return undefined;
  }
};

/**
 * Linkify `#123` and `owner/repo#123` references in prose. Bare
 * `#N` resolves against the thread's own repository (derived from
 * the run key). GitHub's /issues/N door redirects to /pull/N, so
 * one URL shape covers both.
 */
const REF_SPLIT = /((?:[\w.-]+\/[\w.-]+)?#\d+\b)/g;
const LinkifiedText = ({ text, repo }: { text: string; repo?: string }) => (
  <>
    {text.split(REF_SPLIT).map((chunk, index) => {
      const match = chunk.match(/^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/);
      const targetRepo = match?.[1] ?? repo;
      if (!match || !targetRepo) return chunk;
      return (
        <RefHoverCard key={index} repo={targetRepo} number={Number(match[2])}>
          <a
            href={`https://github.com/${targetRepo}/issues/${match[2]}`}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground"
          >
            {chunk}
          </a>
        </RefHoverCard>
      );
    })}
  </>
);

/**
 * Rewrite bare `#N` / `owner/repo#N` references into markdown links
 * (resolved against the thread's repo), leaving code spans and fences
 * untouched so literal `#123`s in code stay literal.
 */
const CODE_SPLIT = /(```[\s\S]*?```|`[^`]*`)/g;
const linkifyMarkdownRefs = (text: string, repo?: string): string =>
  text
    .split(CODE_SPLIT)
    .map((chunk, index) => {
      if (index % 2 === 1) return chunk; // code — leave alone
      return chunk.replace(
        /(?<![\w/[])((?:[\w.-]+\/[\w.-]+)?#\d+)\b/g,
        (whole) => {
          const match = whole.match(/^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/);
          const target = match?.[1] ?? repo;
          if (!match || !target) return whole;
          return `[${whole}](https://github.com/${target}/issues/${match[2]})`;
        },
      );
    })
    .join("");

/** Prose rendered as MARKDOWN (Streamdown) — GitHub refs become
 *  hover-card links via the anchor override. */
const MarkdownText = ({ text, repo }: { text: string; repo?: string }) => (
  <MessageResponse
    components={{
      a: ({ href, children, node: _node, ...rest }: any) => {
        const ref = String(href ?? "").match(
          /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)$/,
        );
        const anchor = (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground"
            {...rest}
          >
            {children}
          </a>
        );
        return ref ? (
          <RefHoverCard repo={ref[1]!} number={Number(ref[2])}>
            {anchor}
          </RefHoverCard>
        ) : (
          anchor
        );
      },
    }}
  >
    {linkifyMarkdownRefs(text, repo)}
  </MessageResponse>
);

/**
 * One text part, upgraded: tagged world events render as timeline
 * rows, `<note>` inputs render as a muted aside — never a JSON dump —
 * and everything else is markdown with linkified GitHub references.
 */
const TextPart = ({
  text,
  repo,
  kind,
}: {
  text: string;
  repo?: string;
  /** Structural provenance from the observation (message metadata). */
  kind?: "note" | "reminder";
}) => {
  // A Thread.remind delivery — the run's own past self speaking.
  // `kind` is the structural signal; the prefix match only covers
  // rows persisted before provenance existed.
  const reminder =
    kind === "reminder" || text.trim().startsWith("[reminder]")
      ? text.trim().replace(/^\[reminder\]\s?/, "")
      : undefined;
  if (reminder !== undefined) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <AlarmClock className="mt-0.5 size-3.5 shrink-0 text-honey" />
        <div className="min-w-0 whitespace-pre-wrap">
          <span className="mr-1.5 font-medium text-honey">reminder</span>
          <LinkifiedText text={reminder} repo={repo} />
        </div>
      </div>
    );
  }
  const note =
    kind === "note" || text.trim().startsWith("<note>")
      ? (text.trim().match(/^<note>\n?([\s\S]*?)\n?<\/note>$/)?.[1] ??
        text.trim())
      : undefined;
  if (note !== undefined) {
    return (
      <div className="whitespace-pre-wrap rounded-md border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-xs italic text-muted-foreground">
        <LinkifiedText text={note} repo={repo} />
      </div>
    );
  }
  const world = parseWorldEvent(text);
  if (world === undefined) {
    return <MarkdownText text={text} repo={repo} />;
  }
  const { event, raw } = world;
  return <EventCard event={event} raw={raw} />;
};

/**
 * A world event as a TIMELINE ROW (GitHub-issue-timeline style): a
 * family-colored icon, a humanized verb, the subject, and the ref —
 * full-width and left-anchored, clearly the world's log rather than
 * anyone's speech bubble. Click to expand author/body/raw; the raw
 * JSON lives in a FIXED-height scroll region so toggling it never
 * reflows the layout.
 */
const EventCard = ({ event, raw }: { event: WorldEvent; raw: string }) => {
  const [open, setOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const anchored = useAnchoredToggle();
  const family = EVENT_FAMILY.find(([test]) => test.test(event.tag))?.[1] ?? {
    icon: Zap,
    className: "text-muted-foreground",
  };
  const FamilyIcon = family.icon;
  return (
    <div className="w-full text-[13px]">
      <button
        type="button"
        onClick={(click) => anchored(click.currentTarget, () => setOpen(!open))}
        className="group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-accent/40"
      >
        <FamilyIcon className={cn("size-3.5 shrink-0", family.className)} />
        <span className="shrink-0 text-muted-foreground">
          {event.author ?? "world"} {eventVerb(event.tag)}
        </span>
        {event.title && (
          <span className="min-w-0 flex-1 truncate">{event.title}</span>
        )}
        {event.repo && event.number !== undefined && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            #{event.number}
          </span>
        )}
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="ml-[7px] border-l border-border/60 py-1 pl-4">
          <div className="flex flex-wrap items-center gap-x-3 font-mono text-xs text-muted-foreground">
            {event.repo &&
              (event.url ? (
                <a
                  href={event.url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-border underline-offset-2 hover:text-foreground"
                >
                  {event.repo}
                  {event.number !== undefined ? `#${event.number}` : ""}
                </a>
              ) : (
                <span>
                  {event.repo}
                  {event.number !== undefined ? `#${event.number}` : ""}
                </span>
              ))}
            <button
              type="button"
              onClick={(click) =>
                anchored(click.currentTarget, () => setShowRaw(!showRaw))
              }
              className="ml-auto cursor-pointer font-mono text-[10px] hover:text-foreground"
            >
              {showRaw ? "▾ raw" : "▸ raw"}
            </button>
          </div>
          {event.body && !showRaw && (
            <div className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
              {event.body}
            </div>
          )}
          {showRaw && (
            <pre className="mt-1.5 h-56 overflow-auto rounded bg-background/60 p-2 text-[10px]">
              {raw}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

/** A thought trace — lives INSIDE the Conversation tree, where the
 *  stick-to-bottom context (and thus anchored toggling) is available. */
const ReasoningTrace = ({
  text,
  streaming,
  open,
  onToggle,
}: {
  text: string;
  streaming: boolean;
  open: boolean;
  onToggle: () => void;
}) => {
  const anchored = useAnchoredToggle();
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={(event) => anchored(event.currentTarget, onToggle)}
        className="flex w-full cursor-pointer items-center gap-1.5 text-left font-medium"
      >
        <span className="font-mono">{open ? "▾" : "▸"}</span>
        {streaming ? (
          <span className="animate-pulse">Thinking…</span>
        ) : (
          "Thought process"
        )}
      </button>
      {open && <div className="mt-2 whitespace-pre-wrap">{text}</div>}
    </div>
  );
};

const Chat = ({
  id,
  initial,
  active,
  agents,
  breadcrumb,
  onOpenThread,
}: {
  id: string;
  initial: UIMessage[];
  active: boolean;
} & ChatContext) => {
  // Persistent run socket — subscribe on mount, re-subscribe after
  // each burst so a parked IssueOwner keeps streaming. `history:
  // "live"`: the transcript hydrates from `initial` (the /messages
  // snapshot); a full replay would render every message twice.
  const agent = useAgent({ chatId: id, history: "live" });
  const { messages, sendMessage, status, stop } = useChat({
    agent,
    messages: initial,
    resume: active,
    persist: active,
  });

  // Pause the socket when the thread is hidden (visited tabs stay
  // mounted). Stopping drops the transport stream; re-selecting with
  // resume/persist opens it again.
  useEffect(() => {
    if (!active) stop();
  }, [active, stop]);

  // "IssueOwner:owner/repo#N" → "owner/repo" — the context bare `#N`
  // references in prose resolve against
  const threadRepo = id.slice(id.indexOf(":") + 1).split("#")[0] || undefined;

  // delegation tool-call → worker thread. Door calls (`AI.Dispatch`)
  // carry their identity on the part (`part.dispatch.child` is the
  // worker's run key) — a DIRECT link. The generic `dispatch`
  // intrinsic without a session falls back to the serial heuristic:
  // the Nth dispatch of agent X is the Nth child run of term X.
  const workerByCall = useMemo(() => {
    const counts = new Map<string, number>();
    const byCall = new Map<string, BoardThread>();
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type !== "dynamic-tool") continue;
        const dispatch = (part as any).dispatch as
          | { agent: string; child: string | undefined }
          | undefined;
        if (dispatch !== undefined) {
          const worker =
            dispatch.child !== undefined
              ? agents.find(
                  (thread) =>
                    thread.id === `${dispatch.agent}:${dispatch.child}`,
                )
              : undefined;
          if (worker !== undefined) {
            byCall.set(part.toolCallId, worker);
            continue;
          }
        }
        const agent =
          dispatch?.agent ??
          (part.toolName === "dispatch" &&
          typeof (part.input as any)?.agent === "string"
            ? ((part.input as any).agent as string)
            : undefined);
        if (agent === undefined) continue;
        const index = counts.get(agent) ?? 0;
        counts.set(agent, index + 1);
        const worker = agents.filter((thread) => thread.term === agent)[index];
        if (worker !== undefined) byCall.set(part.toolCallId, worker);
      }
    }
    return byCall;
  }, [messages, agents]);

  // reasoning expansion is USER-owned: collapsed by default, and a
  // trace the user opened stays open. Keyed by the trace's text
  // prefix — stable while it streams AND across the handoff from the
  // live bubble to the canonical message (the text only appends).
  const [expandedTraces, setExpandedTraces] = useState<Set<string>>(
    () => new Set(),
  );
  const traceKey = (text: string) => text.slice(0, 48);
  const toggleTrace = (key: string) =>
    setExpandedTraces((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Steer the agent DIRECTLY over the run socket — the message lands
  // in the run's inbox as an ordinary input, never as a GitHub comment.
  const onSubmit = (message: PromptInputMessage) => {
    const text = message.text?.trim();
    if (!text) return;
    void sendMessage({ text });
  };

  return (
    <>
      <div className="flex items-center gap-3 border-b border-border px-4 py-2 font-mono text-xs text-muted-foreground">
        {breadcrumb && (
          <button
            type="button"
            onClick={() => onOpenThread(breadcrumb.to)}
            className="shrink-0 rounded border border-border px-2 py-0.5 hover:bg-accent"
          >
            ← {breadcrumb.label}
          </button>
        )}
        <span className="truncate">{id}</span>
      </div>
      {/* initial="instant": open AT the end, no scroll animation */}
      <Conversation className="min-h-0 flex-1" initial="instant">
        <ConversationContent className="mx-auto max-w-3xl">
          {messages.map((message, messageIndex) => {
            // world events and notes carry their own card chrome — the
            // user-bubble around them reads as an ugly double border
            const meta = message.metadata as
              | { kind?: "note" | "reminder"; at?: number }
              | undefined;
            const kind = meta?.kind;
            // DAY DIVIDER: a rule wherever the calendar day advances
            // past the previous message's
            const previousAt = (
              messages[messageIndex - 1]?.metadata as
                | { at?: number }
                | undefined
            )?.at;
            const day = dayOf(meta?.at);
            const newDay =
              day !== undefined &&
              (messageIndex === 0 || day !== dayOf(previousAt));
            const bare =
              message.role === "user" &&
              (kind !== undefined ||
                message.parts.every(
                  (part) =>
                    part.type === "text" &&
                    (parseWorldEvent(part.text) !== undefined ||
                      // legacy rows from before structural provenance
                      part.text.trim().startsWith("<note>") ||
                      part.text.trim().startsWith("[reminder]")),
                ));
            return (
              <div key={message.id} className="contents">
                {newDay && meta?.at !== undefined && (
                  <div className="flex items-center gap-3 py-1">
                    <div className="h-px flex-1 bg-border" />
                    <AtTooltip at={meta.at}>
                      <span className="shrink-0 cursor-default font-mono text-[11px] text-muted-foreground hover:text-foreground">
                        {formatDay(meta.at)}
                      </span>
                    </AtTooltip>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                )}
                <div className="flex items-start gap-2">
                  {/* wall-clock gutter — the observation's `at` */}
                  <div className="w-12 shrink-0 select-none pt-1 text-right font-mono text-[10px] leading-4 text-muted-foreground/60">
                    {meta?.at !== undefined ? (
                      <AtTooltip at={meta.at}>
                        <span className="cursor-default hover:text-foreground">
                          {formatAt(meta.at)}
                        </span>
                      </AtTooltip>
                    ) : null}
                  </div>
                  <Message
                    from={message.role}
                    className={cn("min-w-0 flex-1", bare && "max-w-full")}
                  >
                    {/* world events are TIMELINE ROWS — full-width and
                  left-anchored like the rest of the log, never a
                  speech bubble */}
                    <MessageContent
                      className={cn(
                        // cards must never flex-SHRINK vertically — a
                        // height-squeezed `overflow-hidden` card collapses
                        // into an empty border pill
                        "*:shrink-0",
                        bare &&
                          "w-full max-w-full group-[.is-user]:bg-transparent group-[.is-user]:px-0 group-[.is-user]:py-0",
                      )}
                    >
                      {message.parts.map((part, index) => {
                        if (part.type === "reasoning") {
                          const key = traceKey(part.text);
                          return (
                            <ReasoningTrace
                              key={index}
                              text={part.text}
                              streaming={part.state === "streaming"}
                              open={expandedTraces.has(key)}
                              onToggle={() => toggleTrace(key)}
                            />
                          );
                        }
                        if (part.type === "text") {
                          return (
                            <TextPart
                              key={index}
                              text={part.text}
                              repo={threadRepo}
                              kind={kind}
                            />
                          );
                        }
                        if (part.type === "dynamic-tool") {
                          const tool = part;
                          // orphan part (an output whose call this client
                          // never saw) — nothing renderable, skip it
                          if (!tool.toolName) return null;
                          const dispatchInfo = (tool as any).dispatch as
                            | { agent: string; child: string | undefined }
                            | undefined;
                          if (
                            dispatchInfo !== undefined ||
                            tool.toolName === "dispatch"
                          ) {
                            const worker = workerByCall.get(tool.toolCallId);
                            const agent =
                              dispatchInfo?.agent ??
                              (tool.input as any)?.agent ??
                              "subagent";
                            const running =
                              worker?.status === "running" ||
                              (worker === undefined &&
                                tool.state === "input-available");
                            return (
                              <button
                                key={index}
                                type="button"
                                disabled={worker === undefined}
                                onClick={() =>
                                  worker && onOpenThread(worker.id)
                                }
                                className={cn(
                                  "flex w-full items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-left",
                                  worker !== undefined && "hover:bg-accent",
                                )}
                              >
                                <span
                                  className={cn(
                                    "size-2.5 shrink-0 rounded-full",
                                    running
                                      ? "animate-pulse bg-moss"
                                      : worker?.status === "crashed"
                                        ? "bg-brick"
                                        : "bg-muted-foreground/50",
                                  )}
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block text-sm font-medium">
                                    {agent}
                                    {running ? " — working…" : ""}
                                  </span>
                                  <span className="block truncate text-xs text-muted-foreground">
                                    {String((tool.input as any)?.task ?? "")}
                                  </span>
                                </span>
                                {worker !== undefined && (
                                  <span className="shrink-0 text-xs text-muted-foreground">
                                    {worker.ticks} ticks · view thread →
                                  </span>
                                )}
                              </button>
                            );
                          }
                          const card = (
                            <ToolCard
                              key={index}
                              toolName={tool.toolName}
                              state={tool.state}
                              input={tool.input}
                              output={tool.output}
                              errorText={tool.errorText}
                            />
                          );
                          // registry-rendered tools get the compact card;
                          // unknown tools keep the generic collapsible
                          if (hasToolCard(tool.toolName)) return card;
                          return (
                            <Tool key={index}>
                              <ToolHeader
                                type={tool.type}
                                state={tool.state}
                                toolName={tool.toolName}
                              />
                              <ToolContent>
                                <ToolInput input={tool.input} />
                                <ToolOutput
                                  output={
                                    typeof tool.output === "string" ? (
                                      <pre className="whitespace-pre-wrap p-3 text-xs">
                                        {tool.output}
                                      </pre>
                                    ) : tool.output !== undefined ? (
                                      <pre className="whitespace-pre-wrap p-3 text-xs">
                                        {JSON.stringify(tool.output, null, 2)}
                                      </pre>
                                    ) : undefined
                                  }
                                  errorText={tool.errorText}
                                />
                              </ToolContent>
                            </Tool>
                          );
                        }
                        return null;
                      })}
                    </MessageContent>
                  </Message>
                </div>
              </div>
            );
          })}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="mx-auto w-full max-w-3xl p-4">
        <PromptInput onSubmit={onSubmit}>
          <PromptInputBody>
            {/* pr-12 keeps typed text clear of the submit button */}
            <PromptInputTextarea
              placeholder="Talk to the reviewer…"
              className="pr-12"
            />
          </PromptInputBody>
          <PromptInputSubmit
            status={status === "streaming" ? "streaming" : undefined}
            variant="ghost"
            className="absolute right-2 bottom-2 text-muted-foreground"
          />
        </PromptInput>
      </div>
    </>
  );
};
