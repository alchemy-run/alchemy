import { CodeCard } from "@/components/code";
import { ProposalCard, type Proposal } from "@/components/proposals";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  CircleCheck,
  CircleSlash,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  MessageSquare,
  MessageSquareText,
  RefreshCw,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ComponentType } from "react";

/* ── the server's projection (src/lib/PullRequest.ts) ───────────── */

interface Author {
  login: string;
  avatarUrl: string;
}

interface InlineComment {
  id: number;
  author: Author;
  path: string;
  line: number | undefined;
  startLine: number | undefined;
  body: string;
  diffHunk: string;
  createdAt: string;
  htmlUrl: string;
  inReplyTo: number | undefined;
}

type TimelineItem =
  | {
      kind: "comment";
      id: number;
      author: Author;
      body: string;
      createdAt: string;
      htmlUrl: string;
    }
  | {
      kind: "review";
      id: number;
      author: Author;
      state: string;
      body: string;
      createdAt: string;
      htmlUrl: string;
      comments: InlineComment[];
    };

export interface PullRequestView {
  repo: string;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged" | "draft";
  author: Author;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  head: { ref: string; sha: string; repo: string | undefined };
  base: { ref: string; repo: string };
  checkoutRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  mergeable: boolean | null;
  timeline: TimelineItem[];
}

/** What the PR's MACHINE is doing — the checkout door's last word. */
export type MachineState =
  | { phase: "idle" }
  | { phase: "checking-out" }
  | { phase: "ready"; branch: string; headSha: string | undefined }
  | { phase: "error"; message: string };

const relativeTime = (iso: string): string => {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  const days = Math.floor(seconds / 86_400);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
};

const STATE_PILL: Record<
  PullRequestView["state"],
  { icon: LucideIcon; label: string; className: string }
> = {
  open: {
    icon: GitPullRequest,
    label: "Open",
    className: "bg-moss/15 text-moss",
  },
  merged: {
    icon: GitMerge,
    label: "Merged",
    className: "bg-terracotta/15 text-terracotta",
  },
  closed: {
    icon: GitPullRequestClosed,
    label: "Closed",
    className: "bg-brick/15 text-brick",
  },
  draft: {
    icon: GitPullRequest,
    label: "Draft",
    className: "bg-muted text-muted-foreground",
  },
};

const REVIEW_STATE: Record<
  string,
  { icon: LucideIcon; label: string; className: string }
> = {
  APPROVED: {
    icon: CircleCheck,
    label: "approved these changes",
    className: "text-moss",
  },
  CHANGES_REQUESTED: {
    icon: CircleSlash,
    label: "requested changes",
    className: "text-brick",
  },
  COMMENTED: {
    icon: MessageSquareText,
    label: "reviewed",
    className: "text-mist",
  },
  DISMISSED: {
    icon: CircleSlash,
    label: "review dismissed",
    className: "text-muted-foreground",
  },
};

const AVATAR_SIZE = {
  4: "size-4",
  5: "size-5",
  6: "size-6",
  8: "size-8",
} as const;

const Avatar = ({
  author,
  size = 5,
}: {
  author: Author;
  size?: keyof typeof AVATAR_SIZE;
}) => {
  // a failed load (offline, blocked) shows the disc, not alt text
  const [broken, setBroken] = useState(false);
  return author.avatarUrl && !broken ? (
    <img
      src={author.avatarUrl}
      alt={author.login}
      onError={() => setBroken(true)}
      className={cn("shrink-0 rounded-full", AVATAR_SIZE[size])}
    />
  ) : (
    <span
      role="img"
      aria-label={author.login}
      className={cn(
        "block shrink-0 rounded-full border border-border bg-muted",
        AVATAR_SIZE[size],
      )}
    />
  );
};

const Timestamp = ({ iso, href }: { iso: string; href: string }) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    title={new Date(iso).toLocaleString()}
    className="shrink-0 text-xs text-muted-foreground hover:text-foreground hover:underline"
  >
    {relativeTime(iso)}
  </a>
);

type Markdown = ComponentType<{ text: string; repo?: string }>;

/* ── the conversation's geometry (GitHub's) ──
   A GUTTER on the left holds the connector line and, for comments, the
   author's avatar; cards fill the width from the gutter's edge. The
   line is drawn once, behind everything: cards are opaque, so it shows
   only in the gaps between items and beside event rows (reviews),
   whose icon badge sits centered on it. A comment is never flanked by
   a line — the card's own border is its left edge. */
const GUTTER = "pl-11"; // 44px: a 32px avatar + 12px of air
const LINE_LEFT = "left-[59px]"; // 44px gutter + 16px = the badge's center
const BADGE = "size-8"; // 32px, on the line: center = 44 + 16

/** A GitHub-style comment card: the author's avatar in the gutter,
 *  the verb strip, then the markdown body. Opaque, so it hides the
 *  timeline line behind it. */
const CommentCard = ({
  author,
  createdAt,
  htmlUrl,
  body,
  repo,
  Markdown,
  heading,
}: {
  author: Author;
  createdAt: string;
  htmlUrl: string;
  body: string;
  repo: string;
  Markdown: Markdown;
  /** Replaces the default "commented" verb line. */
  heading?: React.ReactNode;
}) => (
  <div className="relative">
    <div className="absolute top-0 -left-11">
      <Avatar author={author} size={8} />
    </div>
    <div className="rounded-lg border border-border bg-background">
      <div className="flex items-center gap-2 rounded-t-lg border-b border-border bg-muted/30 px-3 py-1.5 text-xs">
        <span className="font-medium">{author.login}</span>
        <span className="text-muted-foreground">{heading ?? "commented"}</span>
        <span className="ml-auto" />
        <Timestamp iso={createdAt} href={htmlUrl} />
      </div>
      <div className="px-3 py-2 text-[13px]">
        {body.trim().length > 0 ? (
          <Markdown text={body} repo={repo} />
        ) : (
          <span className="italic text-muted-foreground">No description.</span>
        )}
      </div>
    </div>
  </div>
);

/** One inline review comment — the anchored hunk, then the note. */
const InlineCommentCard = ({
  comment,
  repo,
  Markdown,
}: {
  comment: InlineComment;
  repo: string;
  Markdown: Markdown;
}) => {
  const [showHunk, setShowHunk] = useState(false);
  const anchor =
    comment.line === undefined
      ? comment.path
      : comment.startLine !== undefined && comment.startLine !== comment.line
        ? `${comment.path}:${comment.startLine}-${comment.line}`
        : `${comment.path}:${comment.line}`;
  return (
    <div className="rounded-md border border-border/70 bg-background">
      <button
        type="button"
        onClick={() => setShowHunk(!showHunk)}
        className="flex w-full items-center gap-2 rounded-t-md bg-muted/40 px-2.5 py-1 text-left font-mono text-[11px] text-muted-foreground hover:text-foreground"
      >
        <span className="truncate">{anchor}</span>
        <span className="ml-auto shrink-0 text-[10px]">
          {showHunk ? "▾ diff" : "▸ diff"}
        </span>
      </button>
      {showHunk && comment.diffHunk.length > 0 && (
        <div className="max-h-64 overflow-auto border-b border-border/70 text-[11px]">
          <CodeCard code={comment.diffHunk} language="diff" />
        </div>
      )}
      <div className="flex items-start gap-2 px-2.5 py-2 text-[13px]">
        <Avatar author={comment.author} size={4} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium">{comment.author.login}</span>
            {comment.inReplyTo !== undefined && (
              <span className="text-muted-foreground">replied</span>
            )}
            <span className="ml-auto" />
            <Timestamp iso={comment.createdAt} href={comment.htmlUrl} />
          </div>
          <div className="mt-1">
            <Markdown text={comment.body} repo={repo} />
          </div>
        </div>
      </div>
    </div>
  );
};

const ReviewCard = ({
  item,
  repo,
  Markdown,
}: {
  item: Extract<TimelineItem, { kind: "review" }>;
  repo: string;
  Markdown: Markdown;
}) => {
  const state = REVIEW_STATE[item.state] ?? REVIEW_STATE.COMMENTED!;
  const StateIcon = state.icon;
  return (
    <div className="flex flex-col gap-2">
      {/* the event row: its badge sits ON the line, the words beside */}
      <div className="flex items-center gap-2 text-xs">
        <span
          className={cn(
            "flex shrink-0 items-center justify-center rounded-full border border-border bg-muted",
            BADGE,
          )}
        >
          <StateIcon className={cn("size-4", state.className)} />
        </span>
        <Avatar author={item.author} size={4} />
        <span className="font-medium">{item.author.login}</span>
        <span className={cn("text-muted-foreground", state.className)}>
          {state.label}
        </span>
        <span className="ml-auto" />
        <Timestamp iso={item.createdAt} href={item.htmlUrl} />
      </div>
      {(item.body.trim().length > 0 || item.comments.length > 0) && (
        <div className="flex flex-col gap-2 pl-10">
          {item.body.trim().length > 0 && (
            <div className="rounded-lg border border-border bg-background px-3 py-2 text-[13px]">
              <Markdown text={item.body} repo={repo} />
            </div>
          )}
          {item.comments.map((comment) => (
            <InlineCommentCard
              key={comment.id}
              comment={comment}
              repo={repo}
              Markdown={Markdown}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * The PULL REQUEST page — GitHub's conversation tab, read here beside
 * the threads and terminals working on the PR: header (state, branches,
 * size), the description, then the timeline of comments and reviews
 * (each review carrying its inline comments). Fetched from
 * `/api/prs/:number`; re-polled while shown so the author's replies and
 * the bot's verdicts land without a reload.
 */
export const PullRequestOverview = ({
  repo,
  number,
  active,
  Markdown,
  machine,
  onCheckout,
  onNewThread,
  onNewTerminal,
  review,
  onRequestReview,
  proposals,
  proposalBusy,
  onAcceptProposal,
  onRejectProposal,
  onOpenSession,
}: {
  repo: string;
  number: number;
  /** Visible right now — polls faster. */
  active: boolean;
  Markdown: Markdown;
  machine: MachineState;
  onCheckout: () => void;
  onNewThread: () => void;
  onNewTerminal: () => void;
  /** The bot's review session, when one exists. */
  review:
    | { status: "none"; requested: boolean; unavailable: boolean }
    | { status: "session"; running: boolean };
  onRequestReview: () => void;
  /** What the agents proposed on THIS pull request, every state,
   *  newest first (src/services/Proposals.ts). */
  proposals?: Proposal[];
  proposalBusy?: ReadonlySet<string>;
  onAcceptProposal?: (id: string) => void;
  onRejectProposal?: (id: string, reason: string | undefined) => void;
  /** Open a session's thread by `${term}:${key}`. */
  onOpenSession?: (id: string) => void;
}) => {
  const [view, setView] = useState<PullRequestView | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    const load = () =>
      fetch(`/api/prs/${number}`)
        .then(async (response) => {
          const data = (await response.json()) as
            | PullRequestView
            | { error: string };
          if (!live) return;
          if ("error" in data) setError(data.error);
          else {
            setView(data);
            setError(undefined);
          }
        })
        .catch((cause: unknown) => {
          if (live) setError(String(cause));
        });
    load();
    const timer = setInterval(load, active ? 15_000 : 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [number, active]);

  if (view === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        {error === undefined ? (
          <>
            <Spinner className="size-4" /> Loading pull request…
          </>
        ) : (
          <span className="font-mono text-xs">{error}</span>
        )}
      </div>
    );
  }

  const pill = STATE_PILL[view.state];
  const PillIcon = pill.icon;
  const fork = view.head.repo !== undefined && view.head.repo !== view.repo;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-5">
        {/* ── header ── */}
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-3">
            <h1 className="min-w-0 flex-1 text-xl font-semibold leading-snug">
              {view.title}{" "}
              <a
                href={view.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="font-mono font-normal text-muted-foreground hover:text-foreground hover:underline"
              >
                #{view.number}
              </a>
            </h1>
            <a
              href={view.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 rounded border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              open on GitHub ↗
            </a>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-medium",
                pill.className,
              )}
            >
              <PillIcon className="size-3.5" />
              {pill.label}
            </span>
            <span className="flex items-center gap-1.5">
              <Avatar author={view.author} size={4} />
              <span className="font-medium text-foreground">
                {view.author.login}
              </span>
              wants to merge {view.commits} commit
              {view.commits === 1 ? "" : "s"} into
            </span>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
              {view.base.ref}
            </span>
            <span>from</span>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
              {fork ? `${view.head.repo}:` : ""}
              {view.head.ref}
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                <span className="text-moss">
                  +{view.additions.toLocaleString()}
                </span>{" "}
                <span className="text-brick">
                  −{view.deletions.toLocaleString()}
                </span>
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                {view.changedFiles} file{view.changedFiles === 1 ? "" : "s"}
              </span>
            </span>
          </div>
        </div>

        {/* ── the MACHINE: one VM for every thread and terminal on this
            PR, its tree the PR head. The checkout door is the "resume
            and pull" act; opening a thread or terminal runs it too. ── */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs">
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">machine</span>
          {machine.phase === "idle" && (
            <span className="text-muted-foreground">
              not touched yet — a thread or terminal checks out{" "}
              <span className="font-mono text-foreground">
                {view.checkoutRef}
              </span>{" "}
              on it first.
            </span>
          )}
          {machine.phase === "checking-out" && (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Spinner className="size-3" /> waking the machine and checking out{" "}
              <span className="font-mono text-foreground">
                {view.checkoutRef}
              </span>
              …
            </span>
          )}
          {machine.phase === "ready" && (
            <span className="text-muted-foreground">
              on{" "}
              <span className="font-mono text-foreground">
                {machine.branch}
              </span>
              {machine.headSha !== undefined && (
                <>
                  {" "}
                  @{" "}
                  <span className="font-mono text-foreground">
                    {machine.headSha.slice(0, 7)}
                  </span>
                </>
              )}
            </span>
          )}
          {machine.phase === "error" && (
            <span
              className="min-w-0 truncate font-mono text-brick"
              title={machine.message}
            >
              {machine.message}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1">
            <button
              type="button"
              title="Re-fetch the pull request head onto the machine"
              disabled={machine.phase === "checking-out"}
              onClick={onCheckout}
              className="flex items-center gap-1 rounded border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className="size-3" /> pull
            </button>
            <button
              type="button"
              onClick={onNewThread}
              className="flex items-center gap-1 rounded border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <MessageSquare className="size-3" /> thread
            </button>
            <button
              type="button"
              onClick={onNewTerminal}
              className="flex items-center gap-1 rounded border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <SquareTerminal className="size-3" /> terminal
            </button>
            {review.status === "none" && (
              <button
                type="button"
                disabled={review.requested || review.unavailable}
                title={
                  review.unavailable
                    ? "the review pipeline is disabled on this deploy"
                    : "ask the review bot for a review"
                }
                onClick={onRequestReview}
                className="flex items-center gap-1 rounded border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <MessageSquareText className="size-3" />
                {review.requested ? "requesting…" : "request review"}
              </button>
            )}
            {review.status === "session" && review.running && (
              <span className="flex items-center gap-1 px-1 font-mono text-[11px] text-moss">
                <span className="size-1.5 animate-pulse rounded-full bg-moss" />
                reviewing
              </span>
            )}
          </span>
        </div>

        {/* ── PROPOSALS: what the agents want to do here, awaiting the
            operator's click (pending first), then what became of the
            rest — the record of the bot's hand on this pull request ── */}
        {proposals !== undefined && proposals.length > 0 && (
          <div
            aria-label="proposals on this pull request"
            className="flex flex-col gap-2"
          >
            <div className="font-mono text-[10px] uppercase text-muted-foreground">
              proposed by agents
            </div>
            {[...proposals]
              .sort(
                (a, b) =>
                  Number(b.status === "pending") -
                    Number(a.status === "pending") || b.at - a.at,
              )
              .map((proposal) => (
                <ProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  Markdown={Markdown}
                  busy={proposalBusy?.has(proposal.id) ?? false}
                  onAccept={() => onAcceptProposal?.(proposal.id)}
                  onReject={(reason) => onRejectProposal?.(proposal.id, reason)}
                  onOpenSession={
                    onOpenSession === undefined
                      ? undefined
                      : () =>
                          onOpenSession(
                            `${proposal.session.term}:${proposal.session.key}`,
                          )
                  }
                />
              ))}
          </div>
        )}

        {/* ── the conversation: description, then the timeline ── */}
        <div className={cn("relative flex flex-col gap-4", GUTTER)}>
          {/* the connector, drawn once behind the whole column */}
          {view.timeline.length > 0 && (
            <div
              aria-hidden
              className={cn(
                "absolute top-4 bottom-4 w-0.5 bg-border/60",
                LINE_LEFT,
              )}
            />
          )}
          <CommentCard
            author={view.author}
            createdAt={view.createdAt}
            htmlUrl={view.htmlUrl}
            body={view.body}
            repo={view.repo}
            Markdown={Markdown}
            heading="opened this pull request"
          />
          {view.timeline.map((item) =>
            item.kind === "comment" ? (
              <CommentCard
                key={`c${item.id}`}
                author={item.author}
                createdAt={item.createdAt}
                htmlUrl={item.htmlUrl}
                body={item.body}
                repo={view.repo}
                Markdown={Markdown}
              />
            ) : (
              <ReviewCard
                key={`r${item.id}`}
                item={item}
                repo={view.repo}
                Markdown={Markdown}
              />
            ),
          )}
        </div>
        {view.timeline.length === 0 && (
          <div className="py-2 text-center text-xs text-muted-foreground">
            No comments yet.
          </div>
        )}
        {error !== undefined && (
          <div className="font-mono text-[11px] text-brick">
            refresh failed: {error}
          </div>
        )}
      </div>
    </div>
  );
};
