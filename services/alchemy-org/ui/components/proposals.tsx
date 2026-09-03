import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
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

/* ── the server's shape (src/services/Proposals.ts) ─────────────── */

export interface ProposedReviewComment {
  path: string;
  line: number;
  start_line?: number;
  body: string;
}

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
  status: ProposalStatus;
  resolvedAt: number | undefined;
  result: string | undefined;
  error: string | undefined;
  reason: string | undefined;
}

type Markdown = ComponentType<{ text: string; repo?: string }>;

/** What accepting DOES — the primary button's label, per kind. */
export const ACCEPT_LABEL: Record<ProposalPayload["kind"], string> = {
  review: "post review",
  comment: "post comment",
  merge: "merge",
  pull_request: "open pull request",
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

const STATUS: Record<
  ProposalStatus,
  { label: string; className: string; icon: LucideIcon | undefined }
> = {
  pending: {
    label: "awaiting you",
    className: "bg-honey/15 text-honey",
    icon: undefined,
  },
  accepted: {
    label: "accepted",
    className: "bg-moss/15 text-moss",
    icon: CircleCheck,
  },
  rejected: {
    label: "declined",
    className: "bg-muted text-muted-foreground",
    icon: CircleSlash,
  },
  failed: {
    label: "failed",
    className: "bg-brick/15 text-brick",
    icon: CircleX,
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
              "w-fit rounded px-1.5 py-0.5 font-mono text-[10px] font-medium",
              VERDICT[payload.verdict].className,
            )}
          >
            {VERDICT[payload.verdict].label}
          </span>
          <div className="text-[13px]">
            <Markdown text={payload.body} repo={repo} />
          </div>
          {payload.comments.length > 0 && (
            <div className="flex flex-col gap-2 border-l-2 border-border/60 pl-3">
              {payload.comments.map((comment, index) => (
                <div key={index} className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {comment.path}:
                    {comment.start_line !== undefined
                      ? `${comment.start_line}-`
                      : ""}
                    {comment.line}
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
            request{" "}
            <span className="font-mono">#{payload.number}</span> into its base.
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
 * what lands); "decline" takes an optional reason the agent reads as
 * its next message. Resolved proposals show what became of them.
 */
export const ProposalCard = ({
  proposal,
  Markdown,
  onAccept,
  onReject,
  onOpenSession,
  busy = false,
  compact = false,
}: {
  proposal: Proposal;
  Markdown: Markdown;
  onAccept: () => void;
  onReject: (reason: string | undefined) => void;
  /** Jump to the proposing session's thread. */
  onOpenSession?: () => void;
  /** An accept is in flight (the GitHub write) — buttons lock. */
  busy?: boolean;
  /** The inbox overlay: summary + actions, body folded. */
  compact?: boolean;
}) => {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [expanded, setExpanded] = useState(!compact);
  const kind = KIND[proposal.payload.kind];
  const status = STATUS[proposal.status];
  const KindIcon = kind.icon;
  const StatusIcon = status.icon;
  const pending = proposal.status === "pending";

  return (
    <div
      data-proposal={proposal.id}
      data-status={proposal.status}
      className={cn(
        "rounded-lg border bg-background",
        pending ? "border-honey/50" : "border-border",
      )}
    >
      <div className="flex items-center gap-2 rounded-t-lg border-b border-border bg-muted/30 px-3 py-1.5 text-xs">
        <KindIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono text-[10px] uppercase text-muted-foreground">
          {kind.label} proposed
        </span>
        <span
          className={cn(
            "flex items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[10px]",
            status.className,
          )}
        >
          {StatusIcon !== undefined && <StatusIcon className="size-3" />}
          {status.label}
        </span>
        <span className="ml-auto" />
        {onOpenSession !== undefined ? (
          <button
            type="button"
            onClick={onOpenSession}
            title="open the proposing session"
            className="max-w-[14rem] truncate font-mono text-[10px] text-muted-foreground hover:text-foreground hover:underline"
          >
            {proposal.session.term}:{proposal.session.key}
          </button>
        ) : (
          <span className="font-mono text-[10px] text-muted-foreground">
            {proposal.session.term}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2 px-3 py-2">
        <div className="text-sm">{proposal.summary}</div>
        {compact && !expanded ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="w-fit font-mono text-[11px] text-muted-foreground hover:text-foreground"
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
            className="w-fit font-mono text-[11px] text-moss hover:underline"
          >
            {proposal.result.replace(/^https:\/\/github\.com\//, "")} ↗
          </a>
        )}
        {proposal.status === "rejected" && (
          <div className="font-mono text-[11px] text-muted-foreground">
            declined{proposal.reason !== undefined ? `: ${proposal.reason}` : ""}
          </div>
        )}
        {proposal.status === "failed" && proposal.error !== undefined && (
          <div className="font-mono text-[11px] text-brick">
            GitHub refused it: {proposal.error}
          </div>
        )}
        {pending && !declining && (
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              disabled={busy}
              onClick={onAccept}
              className="flex flex-1 items-center justify-center gap-1.5 rounded border border-moss/50 px-2 py-1 text-xs text-moss hover:bg-moss/10 disabled:opacity-50"
            >
              {busy && <Spinner className="size-3" />}
              {ACCEPT_LABEL[proposal.payload.kind]}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDeclining(true)}
              className="flex-1 rounded border border-brick/50 px-2 py-1 text-xs text-brick hover:bg-brick/10 disabled:opacity-50"
            >
              decline
            </button>
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
                  setDeclining(false);
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
                className="flex-1 rounded border border-brick/50 px-2 py-1 text-xs text-brick hover:bg-brick/10"
              >
                confirm decline
              </button>
              <button
                type="button"
                onClick={() => setDeclining(false)}
                className="flex-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
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
