import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  ArrowRight,
  ChevronDown,
  CircleCheck,
  CircleSlash,
  CircleX,
  GitMerge,
  GitPullRequestArrow,
  MessageSquare,
  MessageSquareText,
  type LucideIcon,
} from "lucide-react";
import { useState, type ComponentType } from "react";

/* ── the server's shape (src/github/Proposals.ts) ─────────────── */

export interface ProposedReviewComment {
  path: string;
  /** The anchor — the LAST line of a range. */
  line: number;
  /** `RIGHT` (HEAD, the default) or `LEFT` (base — deleted lines). */
  side?: "LEFT" | "RIGHT";
  /** The FIRST line of a range. */
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
  body: string;
}

/** `path:line` or `path:start-line`, marking comments on deleted lines. */
export const commentAnchor = (comment: ProposedReviewComment): string =>
  `${comment.path}:${
    comment.start_line !== undefined ? `${comment.start_line}-` : ""
  }${comment.line}${comment.side === "LEFT" ? " (deleted)" : ""}`;

export type ProposalPayload =
  | {
      kind: "review";
      number: number;
      verdict: "approve" | "request_changes" | "comment";
      body: string;
      comments: ProposedReviewComment[];
    }
  | { kind: "comment"; number: number; body: string }
  | {
      kind: "merge";
      number: number;
      method: "merge" | "squash" | "rebase";
      commitTitle?: string;
      commitMessage?: string;
    }
  | {
      kind: "pull_request";
      title: string;
      body: string;
      head: string;
      base: string;
    };

export type ProposalStatus = "pending" | "accepted" | "rejected" | "failed";

export interface Proposal {
  id: string;
  session: { term: string; key: string };
  repo: string;
  number: number | undefined;
  summary: string;
  payload: ProposalPayload;
  at: number;
  /** Set when the agent revised it in place while pending. */
  revisedAt: number | undefined;
  status: ProposalStatus;
  resolvedAt: number | undefined;
  result: string | undefined;
  error: string | undefined;
  reason: string | undefined;
}

type Markdown = ComponentType<{ text: string; repo?: string }>;

/**
 * Where a proposal lands in the app — the pull request page it is
 * about, or the proposing session for a not-yet-opened pull request.
 * A real link (`href`), so it can be middle-clicked or copied; a plain
 * click routes in-app through `onOpen`.
 */
export interface ProposalTarget {
  href: string;
  label: string;
  onOpen: () => void;
}

/** The proposal on GitHub, once it has a pull request to be on. */
export const proposalGitHubUrl = (proposal: Proposal): string | undefined =>
  proposal.number === undefined
    ? undefined
    : `https://github.com/${proposal.repo}/pull/${proposal.number}`;

/** What accepting DOES — the primary button's label, per kind. */
export const ACCEPT_LABEL: Record<ProposalPayload["kind"], string> = {
  review: "post review",
  comment: "post comment",
  merge: "merge",
  pull_request: "open pull request",
};

/** What accepting DOES, for the button's hover — the irreversible act
 *  spelled out before the click. */
const ACCEPT_TITLE: Record<ProposalPayload["kind"], string> = {
  review:
    "Post review — submit this review on GitHub as the bot: its verdict, body and inline comments, exactly as shown.",
  comment:
    "Post comment — publish this comment on GitHub as the bot, exactly as shown.",
  merge: "Merge — merge the pull request on GitHub now. This cannot be undone.",
  pull_request:
    "Open pull request — create this pull request on GitHub from the branch the agent pushed.",
};

const KIND: Record<
  ProposalPayload["kind"],
  { label: string; icon: LucideIcon }
> = {
  review: { label: "review", icon: MessageSquareText },
  comment: { label: "comment", icon: MessageSquare },
  merge: { label: "merge", icon: GitMerge },
  pull_request: { label: "pull request", icon: GitPullRequestArrow },
};

/** A proposal is a callout in the docs' sense: awaiting you is a
 *  caution (honey), accepted a tip (moss), failed a danger (brick);
 *  declined goes quiet. */
const STATUS: Record<
  ProposalStatus,
  {
    label: string;
    className: string;
    icon: LucideIcon | undefined;
    callout: string;
  }
> = {
  pending: {
    label: "awaiting you",
    className: "callout-title bg-honey/20",
    icon: undefined,
    callout: "callout-caution",
  },
  accepted: {
    label: "accepted",
    className: "bg-moss/15 text-moss-deep",
    icon: CircleCheck,
    callout: "callout-tip",
  },
  rejected: {
    label: "declined",
    className: "bg-muted text-muted-foreground",
    icon: CircleSlash,
    callout: "",
  },
  failed: {
    label: "failed",
    className: "bg-brick/15 text-brick",
    icon: CircleX,
    callout: "callout-danger",
  },
};

const VERDICT: Record<
  Extract<ProposalPayload, { kind: "review" }>["verdict"],
  { label: string; className: string }
> = {
  approve: { label: "APPROVE", className: "bg-moss/15 text-moss" },
  request_changes: {
    label: "REQUEST CHANGES",
    className: "bg-brick/15 text-brick",
  },
  comment: { label: "COMMENT", className: "bg-muted text-muted-foreground" },
};

/** The proposal's body, rendered per kind. */
const ProposalBody = ({
  proposal,
  Markdown,
}: {
  proposal: Proposal;
  Markdown: Markdown;
}) => {
  const { payload, repo } = proposal;
  switch (payload.kind) {
    case "review":
      return (
        <div className="flex flex-col gap-2">
          <span
            className={cn(
              "w-fit rounded-md px-1.5 py-0.5 text-[11px] font-medium",
              VERDICT[payload.verdict].className,
            )}
          >
            {VERDICT[payload.verdict].label}
          </span>
          <div className="text-[13px]">
            <Markdown text={payload.body} repo={repo} />
          </div>
          {payload.comments.length > 0 && (
            <div className="flex flex-col gap-2">
              {payload.comments.map((comment, index) => (
                <div
                  key={index}
                  className="callout callout-note flex flex-col gap-1 px-2.5 py-1.5"
                >
                  <span className="callout-title font-mono text-[11px]">
                    {commentAnchor(comment)}
                  </span>
                  <div className="text-[13px]">
                    <Markdown text={comment.body} repo={repo} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    case "comment":
      return (
        <div className="text-[13px]">
          <Markdown text={payload.body} repo={repo} />
        </div>
      );
    case "merge":
      return (
        <div className="flex flex-col gap-1 text-[13px]">
          <span>
            <span className="font-mono">{payload.method}</span>-merge pull
            request <span className="font-mono">#{payload.number}</span> into
            its base.
          </span>
          {payload.commitTitle !== undefined && (
            <span className="font-mono text-xs text-muted-foreground">
              {payload.commitTitle}
            </span>
          )}
        </div>
      );
    case "pull_request":
      return (
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium">{payload.title}</div>
          <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <span className="rounded bg-muted px-1.5 py-0.5 text-foreground">
              {payload.head}
            </span>
            →
            <span className="rounded bg-muted px-1.5 py-0.5 text-foreground">
              {payload.base}
            </span>
          </div>
          <div className="text-[13px]">
            <Markdown text={payload.body} repo={repo} />
          </div>
        </div>
      );
  }
};

/**
 * One proposal — what an agent wants to do on GitHub, awaiting the
 * operator's click. The primary button IS the act (its label says
 * what lands); "ask for changes" sends the operator's words to the
 * agent, which revises the proposal in place (the card updates,
 * still pending); "decline" takes an optional reason the agent reads
 * as its next message. Resolved proposals show what became of them.
 */
export const ProposalCard = ({
  proposal,
  Markdown,
  onAccept,
  onReject,
  onRevise,
  onOpenSession,
  target,
  busy = false,
  compact = false,
  embedded = false,
}: {
  proposal: Proposal;
  Markdown: Markdown;
  onAccept: () => void;
  onReject: (reason: string | undefined) => void;
  /** Ask the agent for changes — the proposal stays pending. */
  onRevise?: (message: string) => void;
  /** Jump to the proposing session's thread. */
  onOpenSession?: () => void;
  /** Where to jump to see the proposal in place (the inbox sets this;
   *  a card already on its pull request page has nowhere to go). */
  target?: ProposalTarget;
  /** An accept is in flight (the GitHub write) — buttons lock. */
  busy?: boolean;
  /** Summary + actions, body folded behind "show details". */
  compact?: boolean;
  /** Opened under a {@link ProposalRow} that already shows the kind,
   *  the summary and the status: no header, no summary, body shown. */
  embedded?: boolean;
}) => {
  const [mode, setMode] = useState<"actions" | "declining" | "revising">(
    "actions",
  );
  const [reason, setReason] = useState("");
  const [request, setRequest] = useState("");
  const declining = mode === "declining";
  const revising = mode === "revising";
  const [expanded, setExpanded] = useState(!compact);
  const kind = KIND[proposal.payload.kind];
  const status = STATUS[proposal.status];
  const KindIcon = kind.icon;
  const StatusIcon = status.icon;
  const pending = proposal.status === "pending";
  const github = proposalGitHubUrl(proposal);

  return (
    <div
      data-proposal={proposal.id}
      data-status={proposal.status}
      className={cn("callout", status.callout)}
    >
      {!embedded && (
        <div className="flex items-center gap-2 rounded-t-lg border-b border-inherit px-3 py-1.5 text-xs">
          <KindIcon className="callout-title size-3.5 shrink-0" />
          <span className="callout-title text-[11px]">
            {kind.label[0]!.toUpperCase()}
            {kind.label.slice(1)} proposed
          </span>
          <span
            className={cn(
              "flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
              status.className,
            )}
          >
            {StatusIcon !== undefined && <StatusIcon className="size-3" />}
            {status.label}
          </span>
          {pending && proposal.revisedAt !== undefined && (
            <span
              title={new Date(proposal.revisedAt).toLocaleString()}
              className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              revised
            </span>
          )}
          <span className="ml-auto" />
          {onOpenSession !== undefined ? (
            <button
              type="button"
              onClick={onOpenSession}
              title={`Open the ${proposal.session.term} thread that proposed this (${proposal.session.key}) — read its reasoning or talk to it.`}
              className="max-w-[14rem] truncate font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
            >
              {proposal.session.term}:{proposal.session.key}
            </button>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {proposal.session.term}
            </span>
          )}
        </div>
      )}
      <div className="flex flex-col gap-2 px-3 py-2">
        {!embedded && <div className="text-sm">{proposal.summary}</div>}
        {(target !== undefined ||
          (embedded && onOpenSession !== undefined)) && (
          <div className="flex items-center gap-3 text-xs">
            {target !== undefined && (
              <a
                href={target.href}
                title="jump to where this proposal lives"
                onClick={(event) => {
                  // a plain click routes in-app; modified clicks (new tab,
                  // copy link) keep the browser's own behavior
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  ) {
                    return;
                  }
                  event.preventDefault();
                  target.onOpen();
                }}
                className="flex shrink-0 items-center gap-1 whitespace-nowrap text-foreground hover:underline"
              >
                <ArrowRight className="size-3" />
                {target.label}
              </a>
            )}
            {github !== undefined && (
              <a
                href={github}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 whitespace-nowrap text-muted-foreground hover:text-foreground hover:underline"
              >
                github ↗
              </a>
            )}
            {embedded && onOpenSession !== undefined && (
              <button
                type="button"
                onClick={onOpenSession}
                title={`Open the ${proposal.session.term} thread that proposed this (${proposal.session.key}) — read its reasoning or talk to it.`}
                className="ml-auto min-w-0 truncate text-muted-foreground hover:text-foreground hover:underline"
              >
                {proposal.session.term}:{proposal.session.key}
              </button>
            )}
          </div>
        )}
        {compact && !expanded ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            title="Show the full proposal — every comment, the verdict, the body — as it would land on GitHub."
            className="w-fit text-xs text-muted-foreground hover:text-foreground"
          >
            show details
          </button>
        ) : (
          <ProposalBody proposal={proposal} Markdown={Markdown} />
        )}
        {proposal.status === "accepted" && proposal.result !== undefined && (
          <a
            href={proposal.result}
            target="_blank"
            rel="noreferrer"
            className="w-fit text-xs text-moss hover:underline"
          >
            {proposal.result.replace(/^https:\/\/github\.com\//, "")} ↗
          </a>
        )}
        {proposal.status === "rejected" && (
          <div className="text-xs text-muted-foreground">
            declined
            {proposal.reason !== undefined ? `: ${proposal.reason}` : ""}
          </div>
        )}
        {proposal.status === "failed" && proposal.error !== undefined && (
          <div className="text-xs text-brick">
            GitHub refused it: {proposal.error}
          </div>
        )}
        {pending && mode === "actions" && (
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              disabled={busy}
              onClick={onAccept}
              title={ACCEPT_TITLE[proposal.payload.kind]}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-moss/50 px-2.5 py-1.5 text-xs text-moss hover:bg-moss/10 disabled:opacity-50"
            >
              {busy && <Spinner className="size-3" />}
              {ACCEPT_LABEL[proposal.payload.kind]}
            </button>
            {onRevise !== undefined && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setMode("revising")}
                title="Ask for changes — tell the agent what to change; it revises this proposal in place and it stays pending for you."
                className="flex-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground hover:bg-accent disabled:opacity-50"
              >
                ask for changes
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => setMode("declining")}
              title="Decline — nothing is posted to GitHub; you can leave a reason the agent will read."
              className="flex-1 rounded-md border border-brick/50 px-2.5 py-1.5 text-xs text-brick hover:bg-brick/10 disabled:opacity-50"
            >
              decline
            </button>
          </div>
        )}
        {pending && revising && onRevise !== undefined && (
          <div className="flex flex-col gap-2 pt-1">
            <textarea
              autoFocus
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  if (request.trim().length > 0) {
                    onRevise(request.trim());
                    setRequest("");
                    setMode("actions");
                  }
                } else if (event.key === "Escape") {
                  setMode("actions");
                }
              }}
              rows={3}
              placeholder="what should change? the agent revises the proposal in place"
              aria-label="requested changes"
              className="resize-none rounded border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-ring"
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={request.trim().length === 0}
                onClick={() => {
                  onRevise(request.trim());
                  setRequest("");
                  setMode("actions");
                }}
                title="Send to agent — it reads your request and revises the proposal; the revision appears here to accept or decline (⌘↵)."
                className="flex-1 rounded-md border border-primary/60 px-2.5 py-1.5 text-xs text-primary hover:bg-primary/10 disabled:opacity-50"
              >
                send to agent
              </button>
              <button
                type="button"
                onClick={() => setMode("actions")}
                title="Back — keep the proposal as it is, nothing sent (Esc)."
                className="flex-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent"
              >
                back
              </button>
            </div>
          </div>
        )}
        {pending && declining && (
          <div className="flex flex-col gap-2 pt-1">
            <input
              autoFocus
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  onReject(reason.trim() || undefined);
                } else if (event.key === "Escape") {
                  setMode("actions");
                }
              }}
              placeholder="why? (optional — the agent reads this)"
              aria-label="reason for declining"
              className="rounded border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-ring"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onReject(reason.trim() || undefined)}
                title="Confirm decline — the proposal is closed unposted and the agent is told why (↵)."
                className="flex-1 rounded-md border border-brick/50 px-2.5 py-1.5 text-xs text-brick hover:bg-brick/10"
              >
                confirm decline
              </button>
              <button
                type="button"
                onClick={() => setMode("actions")}
                title="Back — keep the proposal pending, nothing declined (Esc)."
                className="flex-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent"
              >
                back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * One proposal as ONE LINE — the kind, the agent's one-line summary,
 * and the status — for the inbox's list. The summary is a link that
 * JUMPS to where the proposal lives; the chevron opens the proposal's
 * card ({@link ProposalCard} `embedded`) underneath, right here.
 */
export const ProposalRow = ({
  proposal,
  target,
  open,
  onToggle,
}: {
  proposal: Proposal;
  /** Where the summary jumps to. */
  target: ProposalTarget;
  open: boolean;
  onToggle: () => void;
}) => {
  const kind = KIND[proposal.payload.kind];
  const status = STATUS[proposal.status];
  const KindIcon = kind.icon;
  const StatusIcon = status.icon;
  return (
    <div className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs">
      <KindIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <a
        href={target.href}
        title={target.label}
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          event.preventDefault();
          target.onOpen();
        }}
        className="min-w-0 flex-1 truncate hover:underline"
      >
        {proposal.summary}
      </a>
      {proposal.status === "pending" && proposal.revisedAt !== undefined && (
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
          revised
        </span>
      )}
      <span
        className={cn(
          "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
          status.className,
        )}
      >
        {StatusIcon !== undefined && <StatusIcon className="size-3" />}
        {status.label}
      </span>
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? "collapse" : "details"}
        title={open ? "collapse" : `${kind.label} — details and actions`}
        onClick={onToggle}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <ChevronDown
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
        />
      </button>
    </div>
  );
};
