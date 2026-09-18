/**
 * ISSUES and PULLS — the org's work, from its own mirror
 * (`/issues/:repo[/:number]`, `/pulls/:repo[/:number]`).
 *
 * The item page copies GitHub's: the big title with its muted
 * number, the state pill, the author line, underline section tabs,
 * a TIMELINE of comment cards on a gutter line (the body is the
 * first card), the comment box with Close/Reopen beside Comment,
 * and a metadata sidebar. Files Changed is @pierre/diffs end to end
 * with @pierre/trees as the file tree — select a file, land on its
 * diff.
 */
import { Avatar, HUMAN } from "@/components/avatar";
import { MarkdownText } from "@/components/chat";
import { FileDiffCard, splitPatchFiles } from "@/components/code";
import {
  addIssueComment,
  createIssue,
  fetchComments,
  fetchIssue,
  fetchIssues,
  fetchPullDiff,
  fetchRepos,
  fetchTimeline,
  patchIssue,
  type ForgeComment,
  type ForgeIssue,
  type SeedStatus,
  type TimelineEvent as ForgeTimelineEvent,
} from "@/lib/forge";
import { showWork, type WorkPlace } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { useTreeStyles } from "@/lib/tree-theme";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { GitStatusEntry } from "@pierre/trees";
import {
  ArrowLeft,
  CheckCircle2,
  CircleDot,
  Eye,
  FileDiff as FileDiffIcon,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Link as LinkIcon,
  MessageSquare,
  Pencil,
  Tag,
  UserPlus,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

const PROSE =
  "text-[14px] leading-relaxed [&_p]:my-2.5 [&_p:first-child]:mt-0 " +
  "[&_p:last-child]:mb-0 [&_ul]:my-2 [&_li]:my-0.5 [&_pre]:my-3";

/** The org's own actors comment as agents; everyone else mirrored
 *  from GitHub is a human. */
const AGENTS = new Set(["head", "manager", "engineer", "reviewer", "root"]);
const kindOf = (login: string) =>
  AGENTS.has(login.toLowerCase()) ? ("agent" as const) : ("human" as const);

const age = (iso: string): string => {
  const ms = Date.now() - Date.parse(iso);
  const days = Math.floor(ms / 86_400_000);
  if (days > 365) return `${Math.floor(days / 365)}y`;
  if (days > 0) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  return hours > 0 ? `${hours}h` : `${Math.max(1, Math.floor(ms / 60_000))}m`;
};

const stateOf = (issue: ForgeIssue) => {
  const isPull = issue.pull_request !== undefined;
  const merged = isPull && issue.pull_request!.merged_at !== null;
  return { isPull, merged };
};

/** The list rows' small pill. */
const StateBadge = ({ issue }: { issue: ForgeIssue }) => {
  const { isPull, merged } = stateOf(issue);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        merged
          ? "bg-purple-500/15 text-purple-400"
          : issue.state === "open"
            ? "bg-moss/15 text-moss"
            : "bg-red-500/15 text-red-400",
      )}
    >
      {merged ? (
        <GitMerge className="size-3" />
      ) : isPull ? (
        <GitPullRequest className="size-3" />
      ) : issue.state === "open" ? (
        <CircleDot className="size-3" />
      ) : (
        <CheckCircle2 className="size-3" />
      )}
      {merged ? "merged" : issue.state}
    </span>
  );
};

/** The item header's big pill — GitHub's filled state button. */
const BigStateBadge = ({ issue }: { issue: ForgeIssue }) => {
  const { isPull, merged } = stateOf(issue);
  const Icon = merged
    ? GitMerge
    : isPull
      ? GitPullRequest
      : issue.state === "open"
        ? CircleDot
        : CheckCircle2;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-semibold text-white",
        merged
          ? "bg-purple-600"
          : issue.state === "open"
            ? "bg-green-700"
            : "bg-red-700/90",
      )}
    >
      <Icon className="size-4" />
      {merged ? "Merged" : issue.state === "open" ? "Open" : "Closed"}
    </span>
  );
};

/** One card on the timeline — GitHub's comment: the avatar on the
 *  gutter line, the header bar, the markdown body. */
const TimelineComment = ({
  author,
  when,
  origin,
  children,
}: {
  author: string;
  when: string;
  origin?: "github" | "local";
  children: React.ReactNode;
}) => (
  <div className="relative flex gap-3">
    <div className="z-[1] shrink-0 pt-0.5">
      <Avatar name={author} kind={kindOf(author)} size={32} />
    </div>
    <div className="min-w-0 flex-1 rounded-md border border-border">
      <div className="flex items-center gap-2 rounded-t-md border-b border-border/70 bg-muted/40 px-3 py-1.5 text-xs">
        <span className="font-semibold">{author}</span>
        <span className="text-muted-foreground">commented {age(when)} ago</span>
        {origin === "local" && (
          <span className="ml-auto rounded-full border border-border/60 px-1.5 py-px text-[10px] text-muted-foreground">
            org
          </span>
        )}
      </div>
      <div className={cn("px-3.5 py-3", PROSE)}>{children}</div>
    </div>
  </div>
);

/** A small EVENT on the timeline — GitHub's dividers: the icon in a
 *  circle on the gutter line, one line of muted text. */
const EventRow = ({
  icon: Icon,
  tone = "muted",
  when,
  children,
}: {
  icon: typeof GitMerge;
  tone?: "muted" | "merged" | "closed" | "open";
  when?: string;
  children: React.ReactNode;
}) => (
  <div className="relative flex items-center gap-3 py-0.5">
    <span
      className={cn(
        "z-[1] flex size-8 shrink-0 items-center justify-center rounded-full border",
        tone === "merged" && "border-transparent bg-purple-600 text-white",
        tone === "closed" && "border-transparent bg-red-700 text-white",
        tone === "open" && "border-transparent bg-green-700 text-white",
        tone === "muted" && "border-border bg-muted text-muted-foreground",
      )}
    >
      <Icon className="size-4" />
    </span>
    <span className="min-w-0 text-[13px] text-muted-foreground">
      {children}
      {when !== undefined && <> · {age(when)} ago</>}
    </span>
  </div>
);

/** A commit on the timeline — GitHub's compact row. */
const CommitRow = ({
  message,
  sha,
  when,
}: {
  message: string;
  sha: string;
  when?: string;
}) => (
  <div className="relative flex items-center gap-3 py-0.5">
    <span className="z-[1] flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground">
      <GitCommitHorizontal className="size-4" />
    </span>
    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
      {message.split("\n")[0]}
    </span>
    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
      {sha.slice(0, 7)}
      {when !== undefined && <> · {age(when)} ago</>}
    </span>
  </div>
);

/** One normalized thing to draw, in time order. */
type TimelineItem =
  | {
      kind: "comment";
      key: string;
      at: number;
      author: string;
      when: string;
      origin: "github" | "local";
      body: string;
    }
  | {
      kind: "review";
      key: string;
      at: number;
      author: string;
      when: string;
      state: string;
      body: string | null;
    }
  | {
      kind: "commit";
      key: string;
      at: number;
      message: string;
      sha: string;
      when?: string;
    }
  | {
      kind: "event";
      key: string;
      at: number;
      icon: typeof GitMerge;
      tone: "muted" | "merged" | "closed" | "open";
      when?: string;
      text: React.ReactNode;
    };

const actorOf = (event: ForgeTimelineEvent): string =>
  ((event.actor ?? event.user) as { login?: string } | undefined)?.login ??
  "ghost";

/** GitHub's timeline events + the org's own comments, one sequence.
 *  GitHub-born comments come FROM the timeline (our mirror holds the
 *  same rows); local comments (negative ids) only exist here. */
const buildTimeline = (
  events: ReadonlyArray<ForgeTimelineEvent>,
  comments: ReadonlyArray<ForgeComment>,
): ReadonlyArray<TimelineItem> => {
  const items: Array<TimelineItem> = [];
  events.forEach((event, index) => {
    const key = `t-${index}`;
    const when =
      (event.created_at as string | undefined) ??
      (event.submitted_at as string | undefined);
    const at = when !== undefined ? Date.parse(when) : Number.NaN;
    switch (event.event) {
      case "commented": {
        if (when === undefined) return;
        items.push({
          kind: "comment",
          key,
          at,
          author: actorOf(event),
          when,
          origin: "github",
          body: String(event.body ?? ""),
        });
        return;
      }
      case "reviewed": {
        if (when === undefined) return;
        items.push({
          kind: "review",
          key,
          at,
          author: actorOf(event),
          when,
          state: String(event.state ?? "commented"),
          body:
            typeof event.body === "string" && event.body.length > 0
              ? event.body
              : null,
        });
        return;
      }
      case "committed": {
        const commit = event as {
          sha?: string;
          message?: string;
          committer?: { date?: string };
          author?: { date?: string };
        };
        const date = commit.committer?.date ?? commit.author?.date;
        items.push({
          kind: "commit",
          key,
          at: date !== undefined ? Date.parse(date) : Number.NaN,
          message: commit.message ?? "",
          sha: commit.sha ?? "",
          when: date,
        });
        return;
      }
      case "merged":
        items.push({
          kind: "event",
          key,
          at,
          icon: GitMerge,
          tone: "merged",
          when,
          text: (
            <>
              <b className="text-foreground">{actorOf(event)}</b> merged commit{" "}
              <code className="font-mono text-xs">
                {String(event.commit_id ?? "").slice(0, 7)}
              </code>
            </>
          ),
        });
        return;
      case "closed":
        items.push({
          kind: "event",
          key,
          at,
          icon: CheckCircle2,
          tone: "closed",
          when,
          text: (
            <>
              <b className="text-foreground">{actorOf(event)}</b> closed this
            </>
          ),
        });
        return;
      case "reopened":
        items.push({
          kind: "event",
          key,
          at,
          icon: CircleDot,
          tone: "open",
          when,
          text: (
            <>
              <b className="text-foreground">{actorOf(event)}</b> reopened this
            </>
          ),
        });
        return;
      case "labeled":
      case "unlabeled":
        items.push({
          kind: "event",
          key,
          at,
          icon: Tag,
          tone: "muted",
          when,
          text: (
            <>
              <b className="text-foreground">{actorOf(event)}</b>{" "}
              {event.event === "labeled" ? "added" : "removed"} the{" "}
              <span className="rounded-full border border-border/60 px-1.5 text-xs">
                {(event.label as { name?: string } | undefined)?.name}
              </span>{" "}
              label
            </>
          ),
        });
        return;
      case "renamed": {
        const rename = event.rename as
          | { from?: string; to?: string }
          | undefined;
        items.push({
          kind: "event",
          key,
          at,
          icon: Pencil,
          tone: "muted",
          when,
          text: (
            <>
              <b className="text-foreground">{actorOf(event)}</b> changed the
              title to <i>{rename?.to}</i>
            </>
          ),
        });
        return;
      }
      case "cross-referenced": {
        const source = event.source as
          | { issue?: { number?: number; title?: string } }
          | undefined;
        items.push({
          kind: "event",
          key,
          at,
          icon: LinkIcon,
          tone: "muted",
          when,
          text: (
            <>
              <b className="text-foreground">{actorOf(event)}</b> mentioned this
              in #{source?.issue?.number}{" "}
              <span className="text-foreground">{source?.issue?.title}</span>
            </>
          ),
        });
        return;
      }
      case "assigned":
      case "review_requested":
        items.push({
          kind: "event",
          key,
          at,
          icon: event.event === "assigned" ? UserPlus : Eye,
          tone: "muted",
          when,
          text: (
            <>
              <b className="text-foreground">{actorOf(event)}</b>{" "}
              {event.event === "assigned"
                ? "assigned"
                : "requested a review from"}{" "}
              <b className="text-foreground">
                {(
                  (event.assignee ?? event.requested_reviewer) as
                    | { login?: string }
                    | undefined
                )?.login ?? "someone"}
              </b>
            </>
          ),
        });
        return;
      case "head_ref_force_pushed":
        items.push({
          kind: "event",
          key,
          at,
          icon: GitCommitHorizontal,
          tone: "muted",
          when,
          text: (
            <>
              <b className="text-foreground">{actorOf(event)}</b> force-pushed
              the head branch
            </>
          ),
        });
        return;
      case "head_ref_deleted":
        items.push({
          kind: "event",
          key,
          at,
          icon: GitBranch,
          tone: "muted",
          when,
          text: (
            <>
              <b className="text-foreground">{actorOf(event)}</b> deleted the
              head branch
            </>
          ),
        });
        return;
      default:
        return; // an event kind we don't draw yet
    }
  });

  // the org's own comments (negative ids) exist only in our store
  for (const comment of comments) {
    if (comment.id >= 0 && events.length > 0) continue;
    items.push({
      kind: "comment",
      key: `c-${comment.id}`,
      at: Date.parse(comment.created_at),
      author: comment.user.login,
      when: comment.created_at,
      origin: comment.id < 0 ? "local" : "github",
      body: comment.body,
    });
  }

  return items
    .filter((item) => Number.isFinite(item.at))
    .sort((left, right) => left.at - right.at);
};

const REVIEW_VERB: Record<string, string> = {
  approved: "approved these changes",
  changes_requested: "requested changes",
  commented: "reviewed",
  dismissed: "reviewed (dismissed)",
};

/* ── Files changed: pierre's tree beside pierre's diffs ──────────── */

interface ParsedFile {
  readonly path: string;
  readonly file: FileDiffMetadata;
  readonly fallback: string;
  readonly status: GitStatusEntry["status"];
}

const parseDiff = (text: string): ReadonlyArray<ParsedFile> => {
  try {
    const files = parsePatchFiles(text).flatMap((patch) => patch.files);
    const raw = splitPatchFiles(text);
    return files.map((file, index) => {
      const fallback = raw[index] ?? text;
      const meta = file as unknown as { name?: string; prevName?: string };
      const path = meta.name ?? `file-${index}`;
      const status: GitStatusEntry["status"] = /^new file mode /m.test(fallback)
        ? "added"
        : /^deleted file mode /m.test(fallback)
          ? "deleted"
          : meta.prevName !== undefined && meta.prevName !== meta.name
            ? "renamed"
            : "modified";
      return { path, file, fallback, status };
    });
  } catch {
    return [];
  }
};

/** `+added −deleted` across the whole diff, counted off the raw text. */
const diffTotals = (text: string): { added: number; deleted: number } => {
  let added = 0;
  let deleted = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) deleted++;
  }
  return { added, deleted };
};

const PullFiles = ({
  files,
  raw,
}: {
  files: ReadonlyArray<ParsedFile>;
  raw: string;
}) => {
  const cards = useRef<Record<string, HTMLDivElement | null>>({});
  const paths = useMemo(() => files.map((entry) => entry.path), [files]);
  const { model } = useFileTree({
    initialExpansion: "open",
    paths: [],
    onSelectionChange: (selected: ReadonlyArray<string>) => {
      const path = selected[0];
      if (path !== undefined) {
        cards.current[path]?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }
    },
  });
  useEffect(() => {
    model.resetPaths([...paths]);
    model.setGitStatus(
      files.map((entry) => ({ path: entry.path, status: entry.status })),
    );
  }, [model, paths, files]);

  const totals = useMemo(() => diffTotals(raw), [raw]);
  const treeStyles = useTreeStyles();

  if (files.length === 0) {
    return (
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap p-2 font-mono text-[11px]">
        {raw}
      </pre>
    );
  }
  return (
    <div className="flex items-start gap-4">
      {/* the tree — @pierre/trees, git-status colored */}
      <aside className="sticky top-3 hidden w-64 shrink-0 md:block">
        <div className="pb-2 text-xs text-muted-foreground">
          {files.length} file{files.length === 1 ? "" : "s"} changed{" "}
          <span className="font-mono text-moss">+{totals.added}</span>{" "}
          <span className="font-mono text-red-400">−{totals.deleted}</span>
        </div>
        <FileTree
          model={model}
          style={{ height: "calc(100dvh - 260px)", ...treeStyles }}
        />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        {files.map((entry) => (
          <div
            key={entry.path}
            ref={(element) => {
              cards.current[entry.path] = element;
            }}
            className="scroll-mt-3"
          >
            <FileDiffCard file={entry.file} fallback={entry.fallback} />
          </div>
        ))}
      </div>
    </div>
  );
};

/* ── the item page — GitHub's layout ─────────────────────────────── */

const ItemView = ({
  kind,
  repo,
  number,
}: {
  kind: "issues" | "pulls";
  repo: string;
  number: number;
}) => {
  const [issue, setIssue] = useState<ForgeIssue | undefined>();
  const [comments, setComments] = useState<ReadonlyArray<ForgeComment>>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<"conversation" | "files">(
    "conversation",
  );
  const [diff, setDiff] = useState<{ ok: boolean; text: string } | undefined>();
  const [events, setEvents] = useState<ReadonlyArray<ForgeTimelineEvent>>([]);
  const [composer, setComposer] = useState<"write" | "preview">("write");

  const reload = () => {
    fetchIssue(repo, number)
      .then(setIssue)
      .catch(() => {});
    fetchComments(repo, number)
      .then(setComments)
      .catch(() => {});
    fetchTimeline(repo, number)
      .then(setEvents)
      .catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [repo, number]);
  useEffect(() => {
    setSection("conversation");
    setDiff(undefined);
  }, [repo, number]);

  const isPull = issue?.pull_request !== undefined;
  useEffect(() => {
    if (!isPull) return;
    let alive = true;
    fetchPullDiff(repo, number)
      .then((body) => {
        if (alive) setDiff(body);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repo, number, isPull]);

  const files = useMemo(
    () => (diff !== undefined && diff.ok ? parseDiff(diff.text) : []),
    [diff],
  );
  const timeline = useMemo(
    () => buildTimeline(events, comments),
    [events, comments],
  );

  if (issue === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        loading #{number}…
      </div>
    );
  }

  const pull = issue.pull_request;
  const participants = [
    ...new Set([issue.user.login, ...comments.map((c) => c.user.login)]),
  ];

  const flip = () => {
    setBusy(true);
    patchIssue(repo, number, {
      state: issue.state === "open" ? "closed" : "open",
    })
      .then(() => reload())
      .finally(() => setBusy(false));
  };
  const submit = () => {
    setBusy(true);
    addIssueComment(repo, number, draft)
      .then(() => {
        setDraft("");
        reload();
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* the header — title, state, the author line, section tabs */}
      <div className="border-b border-border">
        <div className="mx-auto w-full max-w-6xl px-6 pt-5">
          <div className="flex items-start gap-2">
            <button
              type="button"
              onClick={() => showWork(kind, repo)}
              aria-label="back to the list"
              className="mt-1.5 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-accent"
            >
              <ArrowLeft className="size-4" />
            </button>
            <h1 className="min-w-0 text-[26px] font-normal leading-snug">
              {issue.title}{" "}
              <span className="font-light text-muted-foreground">
                #{issue.number}
              </span>
            </h1>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 pl-9 text-sm text-muted-foreground">
            <BigStateBadge issue={issue} />
            <span>
              <span className="font-semibold text-foreground">
                {issue.user.login}
              </span>{" "}
              {pull !== undefined && pull.head_ref !== null ? (
                <>
                  wants to merge{" "}
                  <code className="rounded bg-muted/60 px-1 font-mono text-xs">
                    {pull.head_ref}
                  </code>{" "}
                  into{" "}
                  <code className="rounded bg-muted/60 px-1 font-mono text-xs">
                    {pull.base_ref ?? "main"}
                  </code>
                </>
              ) : (
                <>opened this {age(issue.created_at)} ago</>
              )}{" "}
              · {issue.comments} comment{issue.comments === 1 ? "" : "s"}
            </span>
          </div>
          {/* underline tabs, GitHub's */}
          <nav
            aria-label="item sections"
            className="mt-4 flex items-center gap-1 pl-9"
          >
            <button
              type="button"
              aria-current={section === "conversation" ? "page" : undefined}
              onClick={() => setSection("conversation")}
              className={cn(
                "flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2 text-sm",
                section === "conversation"
                  ? "border-primary font-semibold text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <MessageSquare className="size-4" />
              Conversation
              <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
                {issue.comments}
              </span>
            </button>
            {isPull && (
              <button
                type="button"
                aria-current={section === "files" ? "page" : undefined}
                onClick={() => setSection("files")}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2 text-sm",
                  section === "files"
                    ? "border-primary font-semibold text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <FileDiffIcon className="size-4" />
                Files changed
                {files.length > 0 && (
                  <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
                    {files.length}
                  </span>
                )}
              </button>
            )}
          </nav>
        </div>
      </div>

      {section === "files" ? (
        <div className="mx-auto w-full max-w-[1500px] px-6 py-5">
          {diff === undefined ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              loading the diff…
            </div>
          ) : !diff.ok ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              no diff to show — this pull has no local source yet
            </div>
          ) : (
            <PullFiles files={files} raw={diff.text} />
          )}
        </div>
      ) : (
        <div className="mx-auto flex w-full max-w-6xl items-start gap-8 px-6 py-5">
          {/* the timeline: the body first, then every comment, on the
              gutter line */}
          <div className="relative min-w-0 flex-1 before:absolute before:bottom-0 before:left-4 before:top-2 before:w-px before:bg-border">
            <div className="flex flex-col gap-4">
              <TimelineComment
                author={issue.user.login}
                when={issue.created_at}
              >
                <MarkdownText
                  text={issue.body ?? "*No description provided.*"}
                />
              </TimelineComment>
              {timeline.map((item) =>
                item.kind === "comment" ? (
                  <TimelineComment
                    key={item.key}
                    author={item.author}
                    when={item.when}
                    origin={item.origin}
                  >
                    <MarkdownText text={item.body} />
                  </TimelineComment>
                ) : item.kind === "review" ? (
                  item.body !== null ? (
                    /* a review WITH prose — a comment card wearing
                       the review's verdict in its header */
                    <div key={item.key} className="relative flex gap-3">
                      <div className="z-[1] shrink-0 pt-0.5">
                        <Avatar
                          name={item.author}
                          kind={kindOf(item.author)}
                          size={32}
                        />
                      </div>
                      <div className="min-w-0 flex-1 rounded-md border border-border">
                        <div className="flex items-center gap-2 rounded-t-md border-b border-border/70 bg-muted/40 px-3 py-1.5 text-xs">
                          <Eye
                            className={cn(
                              "size-3.5",
                              item.state === "approved" && "text-moss",
                              item.state === "changes_requested" &&
                                "text-red-400",
                            )}
                          />
                          <span className="font-semibold">{item.author}</span>
                          <span className="text-muted-foreground">
                            {REVIEW_VERB[item.state] ?? "reviewed"} ·{" "}
                            {age(item.when)} ago
                          </span>
                        </div>
                        <div className={cn("px-3.5 py-3", PROSE)}>
                          <MarkdownText text={item.body} />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <EventRow
                      key={item.key}
                      icon={item.state === "approved" ? CheckCircle2 : Eye}
                      tone={item.state === "approved" ? "open" : "muted"}
                      when={item.when}
                    >
                      <b className="text-foreground">{item.author}</b>{" "}
                      {REVIEW_VERB[item.state] ?? "reviewed"}
                    </EventRow>
                  )
                ) : item.kind === "commit" ? (
                  <CommitRow
                    key={item.key}
                    message={item.message}
                    sha={item.sha}
                    when={item.when}
                  />
                ) : (
                  <EventRow
                    key={item.key}
                    icon={item.icon}
                    tone={item.tone}
                    when={item.when}
                  >
                    {item.text}
                  </EventRow>
                ),
              )}

              {/* the comment box — avatar on the line, actions right */}
              <div className="relative flex gap-3 pt-2">
                <div className="z-[1] shrink-0 pt-0.5">
                  <Avatar name={HUMAN.name} kind="human" size={32} />
                </div>
                <div className="min-w-0 flex-1 rounded-md border border-border">
                  {/* GitHub's composer header: Write | Preview */}
                  <div className="flex items-center gap-1 border-b border-border/70 bg-muted/40 px-2 pt-1.5 text-xs">
                    {(["write", "preview"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        aria-current={composer === mode ? "page" : undefined}
                        onClick={() => setComposer(mode)}
                        className={cn(
                          "cursor-pointer rounded-t-md border border-b-0 px-3 py-1.5 capitalize",
                          composer === mode
                            ? "border-border bg-background font-semibold"
                            : "border-transparent text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                  {composer === "write" ? (
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      placeholder="Add your comment here…"
                      rows={4}
                      className="w-full resize-y bg-transparent px-3.5 py-2.5 text-sm outline-none"
                    />
                  ) : (
                    <div className={cn("min-h-24 px-3.5 py-2.5", PROSE)}>
                      <MarkdownText
                        text={
                          draft.trim().length > 0
                            ? draft
                            : "*Nothing to preview*"
                        }
                      />
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2 border-t border-border/50 px-3 py-2">
                    <span className="text-[11px] text-muted-foreground">
                      Markdown is supported
                    </span>
                    <span className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={flip}
                        className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
                      >
                        {issue.state === "open" ? (
                          <>
                            <CheckCircle2 className="size-3.5 text-purple-400" />
                            Close {isPull ? "pull request" : "issue"}
                          </>
                        ) : (
                          <>
                            <CircleDot className="size-3.5 text-moss" />
                            Reopen
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        disabled={busy || draft.trim().length === 0}
                        onClick={submit}
                        className="cursor-pointer rounded-md bg-green-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-600 disabled:opacity-50"
                      >
                        Comment
                      </button>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* the sidebar — labels, branches, participants */}
          <aside className="sticky top-4 hidden w-60 shrink-0 flex-col gap-5 text-xs lg:flex">
            <div>
              <div className="pb-1.5 font-semibold text-muted-foreground">
                Labels
              </div>
              {issue.labels.length === 0 ? (
                <span className="text-muted-foreground">None yet</span>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {issue.labels.map((label) => (
                    <span
                      key={label.name}
                      className="rounded-full border border-border/60 px-2 py-0.5"
                    >
                      {label.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
            {pull !== undefined && pull.head_ref !== null && (
              <div>
                <div className="pb-1.5 font-semibold text-muted-foreground">
                  Branches
                </div>
                <div className="flex flex-col gap-1 font-mono text-[11px]">
                  <span className="truncate">{pull.head_ref}</span>
                  <span className="text-muted-foreground">
                    → {pull.base_ref ?? "main"}
                  </span>
                </div>
              </div>
            )}
            <div>
              <div className="pb-1.5 font-semibold text-muted-foreground">
                {participants.length} participant
                {participants.length === 1 ? "" : "s"}
              </div>
              <div className="flex flex-wrap gap-1">
                {participants.slice(0, 12).map((login) => (
                  <Avatar
                    key={login}
                    name={login}
                    kind={kindOf(login)}
                    size={24}
                  />
                ))}
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
};

/* ── the list page ───────────────────────────────────────────────── */

export const WorkPage = ({
  kind,
  place,
}: {
  kind: "issues" | "pulls";
  place: WorkPlace;
}) => {
  const { repo, number } = place;
  const [repos, setRepos] = useState<ReadonlyArray<SeedStatus>>([]);
  const [state, setState] = useState<"open" | "closed" | "all">("open");
  const [rows, setRows] = useState<ReadonlyArray<ForgeIssue>>([]);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => {
    fetchRepos()
      .then(setRepos)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (number !== undefined) return;
    fetchIssues(repo, kind === "issues" ? "issue" : "pull", state)
      .then(setRows)
      .catch(() => {});
  }, [repo, state, kind, number]);

  if (number !== undefined) {
    return <ItemView kind={kind} repo={repo} number={number} />;
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-border p-2">
        <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          repositories
        </div>
        {repos.map((entry) => {
          const name = entry.repo.split("/")[1] ?? entry.repo;
          return (
            <button
              key={entry.repo}
              type="button"
              onClick={() => showWork(kind, name)}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[13px]",
                name === repo
                  ? "bg-accent font-medium"
                  : "text-muted-foreground hover:bg-accent/60",
              )}
            >
              <FolderGit2 className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">{name}</span>
            </button>
          );
        })}
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-1.5 border-b border-border px-4 py-2">
          {(["open", "closed", "all"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setState(option)}
              className={cn(
                "cursor-pointer rounded-md px-2 py-0.5 text-xs capitalize",
                state === option
                  ? "bg-accent font-semibold"
                  : "text-muted-foreground hover:bg-accent/60",
              )}
            >
              {option}
            </button>
          ))}
          {kind === "issues" && (
            <button
              type="button"
              onClick={() => setCreating((current) => !current)}
              className="ml-auto cursor-pointer rounded-md bg-green-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-green-600"
            >
              New issue
            </button>
          )}
        </header>

        {creating && (
          <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-3">
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Title"
              className="w-full max-w-2xl rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            />
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Describe the work…"
              rows={4}
              className="w-full max-w-2xl rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <button
              type="button"
              disabled={title.trim().length === 0}
              onClick={() => {
                createIssue(repo, { title, body }).then((created) => {
                  setCreating(false);
                  setTitle("");
                  setBody("");
                  showWork(kind, repo, created.number);
                });
              }}
              className="self-start cursor-pointer rounded-md bg-green-700 px-3 py-1 text-xs font-semibold text-white hover:bg-green-600 disabled:opacity-50"
            >
              Submit new issue
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="w-full max-w-3xl divide-y divide-border/40">
            {rows.map((issue) => (
              <button
                key={issue.number}
                type="button"
                onClick={() => showWork(kind, repo, issue.number)}
                className="flex w-full cursor-pointer items-start gap-2.5 px-4 py-2.5 text-left hover:bg-accent/40"
              >
                <StateBadge issue={issue} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">
                    {issue.title}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    #{issue.number} · @{issue.user.login} ·{" "}
                    {age(issue.updated_at)} ago
                  </span>
                </span>
                {issue.comments > 0 && (
                  <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                    <MessageSquare className="size-3" />
                    {issue.comments}
                  </span>
                )}
              </button>
            ))}
            {rows.length === 0 && (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                nothing {state === "all" ? "here" : state} in org/{repo}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
