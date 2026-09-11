/**
 * The CHAT — a session's transcript over the run socket, extracted
 * from the old App so every conversation (a thread's, a channel run's)
 * renders one way: markdown with GitHub refs linkified, world events
 * as timeline rows, reasoning collapsed until asked, tool calls as
 * cards, day dividers, a wall-clock gutter.
 */

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
import { CommitHoverCard, RefHoverCard } from "@/components/ref-hover-card";
import {
  canFoldToolRun,
  hasToolCard,
  MIN_TOOL_RUN,
  ToolCard,
  ToolRun,
} from "@/components/tool-card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAnchoredToggle } from "@/lib/anchor";
import { Ansi } from "@/lib/ansi";
import {
  anchorLabel,
  deleteChatMessages,
  interruptChat,
  parseAnchor,
} from "@/lib/channel";
import {
  onRowMouseDown,
  skipRowClick,
  useSelection,
  yieldLinkContextMenu,
} from "@/lib/selection";
import { cn } from "@/lib/utils";
import type { UIMessage } from "ai";
import { useAgent, useChat } from "alchemy/AI/React";
import {
  AlarmClock,
  ChevronDown,
  CircleDot,
  Copy,
  FileCode2,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  Hash,
  Link2,
  MessageSquare,
  Square,
  Trash2,
  Unlink2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

/* ── time ─────────────────────────────────────────────────────────── */

/** Full local timestamp, tooltip-grade: "Sun, Mar 1, 2026, 02:54:07". */
export const formatFull = (at: number): string =>
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
export const AtTooltip = ({
  at,
  children,
}: {
  at: number;
  children: ReactNode;
}) => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {formatFull(at)}
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
);

/** Compact time for the gutter — day context lives in the dividers. */
export const formatAt = (at: number | undefined): string => {
  if (at === undefined || !Number.isFinite(at)) return "";
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

/** Calendar-day key for divider boundaries. */
export const dayOf = (at: number | undefined): string | undefined =>
  at === undefined || !Number.isFinite(at)
    ? undefined
    : new Date(at).toDateString();

/** "Mar 1" (+ year when not this year) — the day-divider label. */
export const formatDay = (at: number): string => {
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
};

/** Relative age for lists ("3h", "2d"). */
export const timeAgo = (at: number): string => {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

/* ── GitHub events as timeline rows ───────────────────────────────── */

/** GitHub event families → timeline icon + accent. */
export const EVENT_FAMILY: Array<
  [RegExp, { icon: LucideIcon; className: string }]
> = [
  // GitHub's own colors: open is green, merged is the accent, closed
  // is red — the same reading as the thread pane's entity icons
  [/^PullRequestMerged/, { icon: GitMerge, className: "text-terracotta" }],
  [
    /^PullRequestClosed/,
    { icon: GitPullRequestClosed, className: "text-brick" },
  ],
  [/^PullRequest/, { icon: GitPullRequestArrow, className: "text-moss" }],
  [/^IssueComment/, { icon: MessageSquare, className: "text-mist" }],
  [/^IssueClosed/, { icon: CircleDot, className: "text-muted-foreground" }],
  [/^Issue/, { icon: CircleDot, className: "text-moss" }],
  [
    /^(CheckRun|CheckSuite|WorkflowRun|Push)/,
    { icon: Zap, className: "text-honey" },
  ],
];

export const eventFamilyOf = (
  tag: string,
): { icon: LucideIcon; className: string } =>
  EVENT_FAMILY.find(([test]) => test.test(tag))?.[1] ?? {
    icon: Zap,
    className: "text-muted-foreground",
  };

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

export const eventVerb = (tag: string): string =>
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

/* ── markdown with linkified refs and anchor pills ────────────────── */

/**
 * Linkify `#123` and `owner/repo#123` references in prose. Bare
 * `#N` resolves against the context repo. GitHub's /issues/N door
 * redirects to /pull/N, so one URL shape covers both.
 */
const REF_SPLIT = /((?:[\w.-]+\/[\w.-]+)?#\d+\b)/g;
export const LinkifiedText = ({
  text,
  repo,
}: {
  text: string;
  repo?: string;
}) => (
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
 * (resolved against the context repo), leaving code spans, fences,
 * and EXISTING markdown links untouched — a ref inside a link's label
 * is already linked, and rewriting a sub-token of it (`run/repo#12`
 * out of `alchemy-run/repo#12`) nests a link inside a link and breaks
 * the whole message's markdown.
 */
const CODE_SPLIT = /(```[\s\S]*?```|`[^`]*`|\[[^\]]*\]\([^()\s]*\))/g;
export const linkifyMarkdownRefs = (text: string, repo?: string): string =>
  text
    .split(CODE_SPLIT)
    .map((chunk, index) => {
      if (index % 2 === 1) return chunk; // code or a link — leave alone
      return chunk.replace(
        /(?<![\w/[.-])((?:[\w.-]+\/[\w.-]+)?#\d+)\b/g,
        (whole) => {
          const match = whole.match(/^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/);
          const target = match?.[1] ?? repo;
          if (!match || !target) return whole;
          return `[${whole}](https://github.com/${target}/issues/${match[2]})`;
        },
      );
    })
    .join("");

/** How anchor pills act when clicked — the review view provides one;
 *  everywhere else the pill is inert text. */
export const AnchorActionContext = createContext<
  ((href: string) => void) | undefined
>(undefined);

/** A link in rendered markdown. GitHub issue/pull links get hover
 *  cards; `anchor://` links draw as file-line PILLS that focus the
 *  review view when one is listening. */
const MarkdownAnchorLink = ({ href, children, node: _node, ...rest }: any) => {
  const onAnchor = useContext(AnchorActionContext);
  const anchor = typeof href === "string" ? parseAnchor(href) : undefined;
  if (anchor !== undefined) {
    return (
      <button
        type="button"
        onClick={onAnchor === undefined ? undefined : () => onAnchor(href)}
        title={`${anchor.path} L${anchor.start}${anchor.end !== anchor.start ? `–L${anchor.end}` : ""}`}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0 align-text-bottom font-mono text-[11px] text-foreground",
          onAnchor !== undefined && "cursor-pointer hover:bg-accent",
        )}
      >
        <FileCode2 className="size-3 text-mist" />
        {anchorLabel(anchor)}
      </button>
    );
  }
  const url = String(href ?? "");
  const ref = url.match(
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)$/,
  );
  const commit = url.match(
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/commit\/([0-9a-f]{7,40})$/,
  );
  const link = (
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
  if (ref) {
    return (
      <RefHoverCard repo={ref[1]!} number={Number(ref[2])}>
        {link}
      </RefHoverCard>
    );
  }
  if (commit) {
    return (
      <CommitHoverCard repo={commit[1]!} sha={commit[2]!}>
        {link}
      </CommitHoverCard>
    );
  }
  return link;
};

const MARKDOWN_COMPONENTS = { a: MarkdownAnchorLink };

/** Prose rendered as MARKDOWN (Streamdown) — GitHub refs become
 *  hover-card links, `anchor://` links become pills. */
export const MarkdownText = ({
  text,
  repo,
}: {
  text: string;
  repo?: string;
}) => (
  <MessageResponse components={MARKDOWN_COMPONENTS}>
    {linkifyMarkdownRefs(text, repo)}
  </MessageResponse>
);

/* ── transcript parts ─────────────────────────────────────────────── */

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
  const bookkeeping = parseThreadNote(text);
  if (bookkeeping !== undefined) {
    return <ThreadNoteRow note={bookkeeping} repo={repo} />;
  }
  const world = parseWorldEvent(text);
  if (world === undefined) {
    return <MarkdownText text={text} repo={repo} />;
  }
  const { event, raw } = world;
  return <EventCard event={event} raw={raw} />;
};

/* ── the thread's bookkeeping, told to its agent ──────────────────── */

/**
 * What the thread puts in its agent's conversation on the channel's
 * behalf (`Threads.assign`/`unassign`/`place` — see ThreadAgent.ts):
 *
 *   [assigned] owner/repo#N — pull, open — title
 *   [unassigned] owner/repo#N
 *   [channel] login · 2026-09-08T20:25:21.187Z\ntext
 *
 * Rendered as timeline rows like the channel's own — never as the
 * operator's speech bubble. The older `[attached]`/`[detached]`
 * spelling still parses, so transcripts written before the rename
 * keep their rows.
 */
type ThreadNote =
  | {
      kind: "assigned";
      ref: string;
      entity?: "issue" | "pull";
      state?: string;
      title?: string;
    }
  | { kind: "unassigned"; ref: string }
  | { kind: "channel"; author: string; at?: number; text: string };

const ASSIGNED = /^\[(?:assigned|attached)\] /;
const UNASSIGNED = /^\[(?:unassigned|detached)\] /;

const parseThreadNote = (text: string): ThreadNote | undefined => {
  const trimmed = text.trim();
  if (ASSIGNED.test(trimmed)) {
    const [head, meta, ...rest] = trimmed.replace(ASSIGNED, "").split(" — ");
    const [entity, state] = (meta ?? "").split(", ");
    return {
      kind: "assigned",
      ref: (head ?? "").trim(),
      entity: entity === "issue" || entity === "pull" ? entity : undefined,
      state: state?.trim() || undefined,
      title: rest.join(" — ").trim() || undefined,
    };
  }
  if (UNASSIGNED.test(trimmed)) {
    return {
      kind: "unassigned",
      ref: trimmed.replace(UNASSIGNED, "").trim(),
    };
  }
  if (trimmed.startsWith("[channel] ")) {
    const newline = trimmed.indexOf("\n");
    const header = newline === -1 ? trimmed : trimmed.slice(0, newline);
    const body = newline === -1 ? "" : trimmed.slice(newline + 1);
    const [author, stamp] = header.slice("[channel] ".length).split(" · ");
    const at = stamp === undefined ? Number.NaN : Date.parse(stamp.trim());
    return {
      kind: "channel",
      author: (author ?? "").trim() || "channel",
      at: Number.isFinite(at) ? at : undefined,
      text: body,
    };
  }
  return undefined;
};

/** The assigned ref's icon, read like the channel's event rows. */
const entityFamily = (
  entity: "issue" | "pull" | undefined,
  state: string | undefined,
): { icon: LucideIcon; className: string } => {
  if (entity === "pull") {
    if (state === "merged") return eventFamilyOf("PullRequestMerged");
    if (state === "closed") return eventFamilyOf("PullRequestClosed");
    return eventFamilyOf("PullRequestOpened");
  }
  if (entity === "issue") {
    return eventFamilyOf(state === "closed" ? "IssueClosed" : "IssueOpened");
  }
  return { icon: Link2, className: "text-muted-foreground" };
};

/** `owner/repo#N` → a hover-carded link showing just `#N`. */
const RefLink = ({ ref: full }: { ref: string }) => {
  const match = full.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (!match) {
    return <span className="font-mono text-[11px]">{full}</span>;
  }
  return (
    <RefHoverCard repo={match[1]!} number={Number(match[2])}>
      <a
        href={`https://github.com/${match[1]}/issues/${match[2]}`}
        target="_blank"
        rel="noreferrer"
        title={full}
        className="font-mono text-[11px] text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground"
      >
        #{match[2]}
      </a>
    </RefHoverCard>
  );
};

const ThreadNoteRow = ({ note, repo }: { note: ThreadNote; repo?: string }) => {
  const [open, setOpen] = useState(false);
  const anchored = useAnchoredToggle();
  if (note.kind === "assigned") {
    const family = entityFamily(note.entity, note.state);
    const Icon = family.icon;
    return (
      <div
        data-thread-note="assigned"
        className="flex w-full min-w-0 items-center gap-2 px-1 py-0.5 text-[13px]"
      >
        <Icon className={cn("size-3.5 shrink-0", family.className)} />
        <span className="shrink-0 text-muted-foreground">assigned</span>
        {note.title && (
          <span className="min-w-0 flex-1 truncate" title={note.title}>
            {note.title}
          </span>
        )}
        {note.state && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {note.state}
          </span>
        )}
        <RefLink ref={note.ref} />
      </div>
    );
  }
  if (note.kind === "unassigned") {
    return (
      <div
        data-thread-note="unassigned"
        className="flex w-full min-w-0 items-center gap-2 px-1 py-0.5 text-[13px]"
      >
        <Unlink2 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">unassigned</span>
        <span className="min-w-0 flex-1" />
        <RefLink ref={note.ref} />
      </div>
    );
  }
  // a channel message, as said: one line, click for the whole thing
  const firstLine = note.text.split("\n")[0] ?? "";
  const more = note.text.trim() !== firstLine.trim();
  return (
    <div data-thread-note="channel" className="w-full text-[13px]">
      <button
        type="button"
        disabled={!more}
        onClick={(click) => anchored(click.currentTarget, () => setOpen(!open))}
        className={cn(
          "group flex w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left",
          more && "cursor-pointer hover:bg-accent/40",
        )}
      >
        <Hash className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">{note.author}</span>
        <span className="min-w-0 flex-1 truncate">
          <LinkifiedText text={firstLine} repo={repo} />
        </span>
        {note.at !== undefined && (
          <AtTooltip at={note.at}>
            <span className="shrink-0 cursor-default font-mono text-[11px] text-muted-foreground">
              {formatAt(note.at)}
            </span>
          </AtTooltip>
        )}
        {more && (
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground opacity-0 transition-all group-hover:opacity-100",
              !open && "-rotate-90",
            )}
          />
        )}
      </button>
      {open && (
        <div className="ml-[7px] whitespace-pre-wrap border-l border-border/60 py-1 pl-4 text-xs text-muted-foreground">
          <LinkifiedText text={note.text} repo={repo} />
        </div>
      )}
    </div>
  );
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
  const family = eventFamilyOf(event.tag);
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
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground opacity-0 transition-all group-hover:opacity-100",
            !open && "-rotate-90",
          )}
        />
      </button>
      {open && (
        <div className="ml-[7px] border-l border-border/60 py-1 pl-4">
          <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
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
              className="ml-auto cursor-pointer text-[11px] hover:text-foreground"
            >
              {showRaw ? "hide raw" : "show raw"}
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
  // No box: a thought is a muted one-liner in the flow of the reply,
  // the way an editor renders it — the chevron only appears on hover,
  // so a trace nobody opens costs one quiet line and nothing else.
  return (
    <div
      data-reasoning=""
      className="group -mx-1 px-1 text-xs text-muted-foreground/70"
    >
      <button
        type="button"
        onClick={(event) => anchored(event.currentTarget, onToggle)}
        className="flex cursor-pointer items-center gap-1 py-0.5 text-left hover:text-muted-foreground"
      >
        {streaming ? (
          <span className="animate-pulse">Thinking…</span>
        ) : (
          "Thought process"
        )}
        <ChevronDown
          className={cn(
            "size-3 transition-[opacity,transform] opacity-0 group-hover:opacity-100",
            !open && "-rotate-90",
          )}
        />
      </button>
      {open && (
        <div className="mt-1 whitespace-pre-wrap border-l border-border/60 pl-3 text-muted-foreground">
          {text}
        </div>
      )}
    </div>
  );
};

/**
 * A user-role message that is the WORLD speaking, not the operator —
 * a GitHub event, a note, a reminder, the thread's bookkeeping. These
 * render as full-width timeline rows (the bubble around them reads as
 * an ugly double border), and consecutive ones stack.
 */
const isBare = (message: UIMessage): boolean => {
  const kind = (message.metadata as { kind?: string } | undefined)?.kind;
  return (
    message.role === "user" &&
    (kind !== undefined ||
      message.parts.every(
        (part) =>
          part.type === "text" &&
          (parseWorldEvent(part.text) !== undefined ||
            part.text.trim().startsWith("<note>") ||
            part.text.trim().startsWith("[reminder]") ||
            parseThreadNote(part.text) !== undefined),
      ))
  );
};

type Part = UIMessage["parts"][number];
type ToolPart = Extract<Part, { type: "dynamic-tool" }>;

/** How a message's parts render: one at a time, or a RUN of the same
 *  tool folded into one line. */
type RenderItem =
  | { readonly kind: "part"; readonly index: number; readonly part: Part }
  | {
      readonly kind: "run";
      readonly index: number;
      readonly toolName: string;
      readonly calls: ReadonlyArray<ToolPart>;
    };

/**
 * Fold a message's parts: {@link MIN_TOOL_RUN} or more consecutive
 * calls of one card-bearing tool become a run (the step boundaries
 * between sequential ticks are transparent); text, reasoning, and a
 * different tool end the run. Parts the caller rules out (superseded
 * cards, orphans) are dropped before folding, so they neither join
 * nor break a run.
 */
const foldToolRuns = (
  parts: ReadonlyArray<Part>,
  skip: (part: Part, index: number) => boolean,
): ReadonlyArray<RenderItem> => {
  const items: Array<RenderItem> = [];
  let run: Array<{ index: number; part: ToolPart }> = [];
  const flush = () => {
    if (run.length >= MIN_TOOL_RUN) {
      items.push({
        kind: "run",
        index: run[0]!.index,
        toolName: run[0]!.part.toolName,
        calls: run.map((entry) => entry.part),
      });
    } else {
      for (const entry of run) {
        items.push({ kind: "part", index: entry.index, part: entry.part });
      }
    }
    run = [];
  };
  parts.forEach((part, index) => {
    if (skip(part, index)) return;
    // a step boundary between two ticks of the same tool is not a break
    if (part.type === "step-start") return;
    if (
      part.type === "dynamic-tool" &&
      part.toolName &&
      canFoldToolRun(part.toolName)
    ) {
      if (run.length > 0 && run[0]!.part.toolName !== part.toolName) flush();
      run.push({ index, part });
      return;
    }
    flush();
    items.push({ kind: "part", index, part });
  });
  flush();
  return items;
};

/* ── the chat ─────────────────────────────────────────────────────── */

export interface ChatProps {
  /** The session id (`Thread:t-…`, `Channel:main@42`). */
  id: string;
  /** Selected — focuses the prompt. */
  active: boolean;
  /** The repository bare `#N` references resolve against. */
  repo?: string;
  /** Placeholder for the prompt ("Talk to the thread…"). */
  placeholder?: string;
  /** Hide the composer (read-only transcript, e.g. a channel run). */
  readOnly?: boolean;
  /** Hide the trailing assistant reply — for a channel RUN, the final
   *  text is the channel's message (Routes lands it there); the rail
   *  shows only the exploration that produced it. */
  hideFinalReply?: boolean;
  /** Extra content pinned under the composer (the review's pill row
   *  is passed through `composerExtra`). */
  composerExtra?: ReactNode;
  /** Rewrite the outgoing text just before it is sent (the review
   *  appends its pills as `anchor://` links here). */
  transformSubmit?: (text: string) => string;
}

const ChatTranscript = ({
  id,
  initial,
  hydrated,
  active,
  repo,
  placeholder,
  readOnly,
  hideFinalReply,
  composerExtra,
  transformSubmit,
}: ChatProps & {
  initial: UIMessage[];
  /** false = no snapshot endpoint — replay over the socket. */
  hydrated: boolean;
}) => {
  // Persistent run socket — subscribe on mount, re-subscribe after
  // each burst. `history: "live"` when the transcript hydrated from
  // `initial` (a full replay would render every message twice);
  // `"replay"` when the snapshot failed and the socket owns history.
  const agent = useAgent({
    chatId: id,
    history: hydrated ? "live" : "replay",
  });
  // The socket stays OPEN while the view is hidden — visited tabs are
  // never paused (stopping on hide forced a full replay on re-select,
  // which rebuilt the conversation and snapped the scroll).
  const { messages, sendMessage, status } = useChat({
    agent,
    messages: initial,
    resume: true,
    persist: true,
  });

  // A selected chat is a chat you're about to TALK to — put the caret
  // in the prompt (first visit and every return).
  const promptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!active) return;
    promptRef.current?.querySelector("textarea")?.focus();
  }, [active]);

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

  const onSubmit = (message: PromptInputMessage) => {
    const text = message.text?.trim();
    if (!text) return;
    void sendMessage({ text: transformSubmit?.(text) ?? text });
  };

  // DELETION is optimistic: hide the messages now, redact them on the
  // server (the whole burst behind an assistant message). Only
  // durable rows delete — a `live-*` streaming sample isn't a row
  // yet. The snapshot on the next mount won't contain deleted rows.
  // Deferred a tick so the menu that asked has closed before the
  // confirm blocks.
  const [deleted, setDeleted] = useState<Set<string>>(() => new Set());
  const removeMessages = useCallback(
    (ids: ReadonlyArray<string>) => {
      const durable = ids.filter((messageId) =>
        /^(u|a|crash|abort)-\d+$/.test(messageId),
      );
      if (durable.length === 0) return;
      setTimeout(() => {
        if (
          !window.confirm(
            durable.length === 1
              ? "Delete this message from the transcript?"
              : `Delete ${durable.length} messages from the transcript?`,
          )
        ) {
          return;
        }
        setDeleted((current) => {
          const next = new Set(current);
          for (const messageId of durable) next.add(messageId);
          return next;
        });
        void deleteChatMessages(id, durable).catch(() => {});
      }, 0);
    },
    [id],
  );

  // SELECTION over the transcript (click / ⌘ / ⇧) and the ids the
  // open context menu acts on
  const order = useMemo(
    () =>
      messages
        .filter((message) => !deleted.has(message.id))
        .map((message) => message.id),
    [messages, deleted],
  );
  const selection = useSelection(order, { onDelete: removeMessages });
  const [menuIds, setMenuIds] = useState<ReadonlyArray<string>>([]);
  const many = menuIds.length > 1 ? `${menuIds.length} messages` : undefined;
  const textOf = (messageId: string) =>
    messages
      .find((message) => message.id === messageId)
      ?.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n") ?? "";

  // The final reply is the CHANNEL's message (Routes lands the run's
  // quiescent text there) — the rail shows the exploration, not the
  // answer. The reply is the text of the trailing assistant message
  // AFTER its last tool call (the whole burst renders as one message);
  // tool cards and reasoning stay visible.
  const lastMessage = messages[messages.length - 1];
  const finalReplyId =
    hideFinalReply === true &&
    lastMessage !== undefined &&
    lastMessage.role === "assistant"
      ? lastMessage.id
      : undefined;

  // ONE card per tool call. An in-flight call is a durable row, so a
  // snapshot taken while its handler runs already shows it; when the
  // sampling lands, the live tail restates the call — into the same
  // message when the snapshot's last message was that burst (the AI
  // SDK continues it), else into a fresh one. The LAST message naming
  // a call owns its card: it is the one the result will reach.
  const toolOwner = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "dynamic-tool")
        toolOwner.set(part.toolCallId, message.id);
    }
  }
  const superseded = (message: UIMessage, part: UIMessage["parts"][number]) =>
    part.type === "dynamic-tool" &&
    toolOwner.get(part.toolCallId) !== message.id;

  return (
    <>
      {/* initial="instant": open AT the end, no scroll animation */}
      <Conversation className="min-h-0 flex-1" initial="instant">
        <ConversationContent className="mx-auto max-w-3xl">
          {/* ONE menu for the transcript; the row under the pointer
              picks the ids (its own, or the selection it belongs to) */}
          <ContextMenu
            onOpenChange={(open) => {
              // the menu closing ends the gesture — target and selection go
              if (!open) {
                setMenuIds([]);
                selection.clear();
              }
            }}
          >
            <ContextMenuTrigger asChild>
              <div
                className="contents"
                onContextMenuCapture={yieldLinkContextMenu}
                onContextMenu={(event) => {
                  // off a row there is nothing to act on — no menu
                  if (
                    !(event.target instanceof Element) ||
                    event.target.closest("[data-message-id]") === null
                  ) {
                    event.preventDefault();
                  }
                }}
              >
                {messages.map((message, messageIndex) => {
                  if (deleted.has(message.id)) return null;
                  // the reply: every text part after the message's last tool
                  // call (all of them when it called none)
                  const lastToolIndex =
                    message.id === finalReplyId
                      ? message.parts.findLastIndex(
                          (part) => part.type === "dynamic-tool",
                        )
                      : Number.POSITIVE_INFINITY;
                  const isReplyText = (index: number) => index > lastToolIndex;
                  // a message that is ONLY the reply — or only cards a
                  // later message took over — vanishes entirely
                  if (
                    message.parts.every(
                      (part, index) =>
                        (part.type === "text" && isReplyText(index)) ||
                        part.type === "step-start" ||
                        superseded(message, part),
                    )
                  ) {
                    return null;
                  }
                  const meta = message.metadata as
                    | {
                        kind?: "note" | "reminder";
                        at?: number;
                        aborted?: boolean;
                      }
                    | undefined;
                  const kind = meta?.kind;
                  // DAY DIVIDER: a rule wherever the calendar day advances
                  // — against the nearest earlier message that HAS a clock
                  // (a message without one must not read as a new day)
                  let previousAt: number | undefined;
                  for (let back = messageIndex - 1; back >= 0; back--) {
                    previousAt = (
                      messages[back]?.metadata as { at?: number } | undefined
                    )?.at;
                    if (previousAt !== undefined) break;
                  }
                  const day = dayOf(meta?.at);
                  const newDay =
                    day !== undefined &&
                    (messageIndex === 0 || day !== dayOf(previousAt));
                  const bare = isBare(message);
                  // consecutive timeline rows STACK like the channel's — the
                  // conversation's message gap is for speech, not for a log
                  const stacked =
                    bare &&
                    !newDay &&
                    messageIndex > 0 &&
                    isBare(messages[messageIndex - 1]!);
                  return (
                    <div key={message.id} className="contents">
                      {newDay && meta?.at !== undefined && (
                        <div className="flex items-center gap-3 py-1">
                          <div className="h-px flex-1 bg-border" />
                          <AtTooltip at={meta.at}>
                            <span className="shrink-0 cursor-default text-[11px] text-muted-foreground hover:text-foreground">
                              {formatDay(meta.at)}
                            </span>
                          </AtTooltip>
                          <div className="h-px flex-1 bg-border" />
                        </div>
                      )}
                      <div
                        data-message-id={message.id}
                        data-selected={
                          selection.has(message.id) ? "" : undefined
                        }
                        data-targeted={
                          menuIds.includes(message.id) ? "" : undefined
                        }
                        onMouseDown={onRowMouseDown}
                        onClick={(event: MouseEvent) => {
                          if (!skipRowClick(event)) {
                            selection.click(message.id, event);
                          }
                        }}
                        onContextMenu={() =>
                          setMenuIds(selection.target(message.id))
                        }
                        className={cn(
                          "-mx-2 -my-1.5 flex items-start gap-2 rounded-md border-l-2 border-transparent px-1.5 py-1.5 transition-colors",
                          stacked && "-mt-8",
                          // the row under the pointer lifts; a selected one stays lit
                          selection.has(message.id) ||
                            menuIds.includes(message.id)
                            ? "border-primary/60 bg-accent/60"
                            : "hover:bg-accent/70",
                        )}
                      >
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
                          <MessageContent
                            className={cn(
                              // cards must never flex-SHRINK vertically — a
                              // height-squeezed `overflow-hidden` card
                              // collapses into an empty border pill
                              "*:shrink-0",
                              bare &&
                                "w-full max-w-full group-[.is-user]:bg-transparent group-[.is-user]:px-0 group-[.is-user]:py-0",
                            )}
                          >
                            {foldToolRuns(message.parts, (part, index) =>
                              part.type === "text"
                                ? isReplyText(index)
                                : part.type === "dynamic-tool"
                                  ? // orphan part (an output whose call this
                                    // client never saw) — nothing renderable;
                                    // restated in a later message — that one
                                    // renders the card
                                    !part.toolName || superseded(message, part)
                                  : false,
                            ).map((item) => {
                              if (item.kind === "run") {
                                return (
                                  <ToolRun
                                    key={item.index}
                                    toolName={item.toolName}
                                    calls={item.calls.map((call) => ({
                                      toolName: call.toolName,
                                      state: call.state,
                                      input: call.input,
                                      output: call.output,
                                      errorText: call.errorText,
                                    }))}
                                  />
                                );
                              }
                              const { part, index } = item;
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
                                    repo={repo}
                                    kind={kind}
                                  />
                                );
                              }
                              if (part.type === "dynamic-tool") {
                                const tool = part;
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
                                // registry-rendered tools get the compact
                                // card; unknown tools keep the generic
                                // collapsible
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
                                              <Ansi text={tool.output} />
                                            </pre>
                                          ) : tool.output !== undefined ? (
                                            <pre className="whitespace-pre-wrap p-3 text-xs">
                                              {JSON.stringify(
                                                tool.output,
                                                null,
                                                2,
                                              )}
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
                            {/* the operator's stop — a quiet marker where the
                          round was cut short (live: the turn's finish
                          carried it; snapshot: the burst wears it) */}
                            {meta?.aborted === true && (
                              <div
                                data-aborted
                                className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground"
                              >
                                <Square className="size-3 fill-current" />
                                Stopped
                              </div>
                            )}
                          </MessageContent>
                        </Message>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                onSelect={() => {
                  void navigator.clipboard
                    ?.writeText(menuIds.map(textOf).join("\n\n"))
                    .catch(() => {});
                }}
              >
                <Copy />
                Copy text
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                onSelect={() => removeMessages(menuIds)}
              >
                <Trash2 />
                {many === undefined ? "Delete" : `Delete ${many}`}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      {!readOnly && (
        <div ref={promptRef} className="mx-auto w-full max-w-3xl p-4">
          <PromptInput onSubmit={onSubmit}>
            <PromptInputBody>
              {composerExtra}
              {/* pr-12 keeps typed text clear of the submit button */}
              <PromptInputTextarea
                placeholder={placeholder ?? "Say something…"}
                className="pr-12"
              />
            </PromptInputBody>
            {/* while the agent works the button is STOP: abort the
                round on the server (the session lives on); the turn's
                end arrives over the socket and the button turns back */}
            <PromptInputSubmit
              status={status === "streaming" ? "streaming" : undefined}
              onStop={() => {
                void interruptChat(id).catch(() => {});
              }}
              variant="ghost"
              className="absolute right-2 bottom-2 text-muted-foreground"
            />
          </PromptInput>
        </div>
      )}
    </>
  );
};

/** A session's chat: snapshot first, then the live socket tail. */
export const ChatView = (props: ChatProps) => {
  const [initial, setInitial] = useState<{
    messages: UIMessage[];
    /** Snapshot delivered → socket tails live from the watermark. A
     *  failed snapshot → the socket replays the full history. */
    hydrated: boolean;
  }>();

  // snapshot first; drop the snapshot's in-flight `live-*` sample —
  // the socket restates that burst durably, and keeping both renders
  // the reasoning twice (one stuck on "Thinking…" forever).
  useEffect(() => {
    setInitial(undefined);
    fetch(`/api/chats/${encodeURIComponent(props.id)}/messages`)
      .then(async (response) =>
        response.ok
          ? {
              messages: ((await response.json()) as UIMessage[]).filter(
                (m) => !m.id.startsWith("live-"),
              ),
              hydrated: true,
            }
          : { messages: [], hydrated: false },
      )
      .then(setInitial)
      .catch(() => setInitial({ messages: [], hydrated: false }));
  }, [props.id]);

  if (initial === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }
  return (
    <ChatTranscript
      {...props}
      initial={initial.messages}
      hydrated={initial.hydrated}
    />
  );
};

/** Avatar-ish identicon for a GitHub login (no API call). */
export const authorAvatarUrl = (login: string): string =>
  `https://github.com/${encodeURIComponent(login)}.png?size=64`;
