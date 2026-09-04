import { CodeCard, FileDiffCard } from "@/components/code";
import { ProposalCard, type Proposal } from "@/components/proposals";
import { Spinner } from "@/components/ui/spinner";
import {
  fetchChangedFiles,
  LARGE_FILE_LINES,
  toGitDiff,
  type ChangedFile,
} from "@/lib/diff";
import {
  NAVIGATE_EVENT,
  overviewId,
  pathOf,
  tabFromLocation,
  withTab,
  type OverviewTab,
} from "@/lib/routes";
import { cn } from "@/lib/utils";
import {
  parsePatchFiles,
  type DiffLineAnnotation,
  type FileDiffMetadata,
} from "@pierre/diffs";
import {
  CircleCheck,
  CircleSlash,
  ExternalLink,
  FileDiff as FileDiffIcon,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  MessageSquare,
  MessageSquareText,
  RefreshCw,
  Sparkles,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";

/* ── the server's projection (src/github/PullRequest.ts) ───────────── */

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
  side: "LEFT" | "RIGHT";
  outdated: boolean;
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

/** A review wears the docs' callout of its verdict: approved is a
 *  tip (moss), changes requested a caution (honey), a plain review a
 *  note (slate). */
const REVIEW_STATE: Record<
  string,
  { icon: LucideIcon; label: string; className: string; callout: string }
> = {
  APPROVED: {
    icon: CircleCheck,
    label: "approved these changes",
    className: "text-moss",
    callout: "callout-tip",
  },
  CHANGES_REQUESTED: {
    icon: CircleSlash,
    label: "requested changes",
    className: "text-brick",
    callout: "callout-caution",
  },
  COMMENTED: {
    icon: MessageSquareText,
    label: "reviewed",
    className: "text-mist",
    callout: "callout-note",
  },
  DISMISSED: {
    icon: CircleSlash,
    label: "review dismissed",
    className: "text-muted-foreground",
    callout: "",
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

/** An author's login, a link to their GitHub profile — as on GitHub. */
const Login = ({
  author,
  className,
}: {
  author: Author;
  className?: string;
}) => (
  <a
    href={`https://github.com/${author.login}`}
    target="_blank"
    rel="noreferrer"
    title={`Open @${author.login} on github.com.`}
    className={cn("font-medium text-foreground hover:underline", className)}
  >
    {author.login}
  </a>
);

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

/** A GitHub-style comment card: the author's avatar in the gutter
 *  (or, for the top-level description, in the strip itself), the verb
 *  strip, then the markdown body. Opaque, so it hides the timeline
 *  line behind it. */
const CommentCard = ({
  author,
  createdAt,
  htmlUrl,
  body,
  repo,
  Markdown,
  heading,
  gutter = true,
}: {
  author: Author;
  createdAt: string;
  htmlUrl: string;
  body: string;
  repo: string;
  Markdown: Markdown;
  /** Replaces the default "commented" verb line. */
  heading?: React.ReactNode;
  /** `false` for a card that stands alone at full width — the avatar
   *  moves into the strip, and nothing hangs in a gutter. */
  gutter?: boolean;
}) => (
  <div className="relative">
    {gutter && (
      <div className="absolute top-0 -left-11">
        <Avatar author={author} size={8} />
      </div>
    )}
    <div className="rounded-lg border border-border bg-background">
      <div className="flex items-center gap-2 rounded-t-lg border-b border-border bg-muted/30 px-3 py-1.5 text-xs">
        {!gutter && <Avatar author={author} size={5} />}
        <Login author={author} />
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
    <div className="callout callout-note">
      <button
        type="button"
        onClick={() => setShowHunk(!showHunk)}
        title={
          showHunk
            ? "Hide the diff lines this comment was left on."
            : `Show the diff lines this comment was left on (${anchor}).`
        }
        className="callout-title flex w-full items-center gap-2 rounded-t-md px-2.5 py-1 text-left text-[11px] hover:underline"
      >
        <span className="truncate font-mono">{anchor}</span>
        <span className="ml-auto shrink-0">
          {showHunk ? "hide diff" : "show diff"}
        </span>
      </button>
      {showHunk && comment.diffHunk.length > 0 && (
        <div className="max-h-64 overflow-auto border-b border-inherit text-[11px]">
          <CodeCard code={comment.diffHunk} language="diff" />
        </div>
      )}
      <div className="flex items-start gap-2 px-2.5 py-2 text-[13px]">
        <Avatar author={comment.author} size={4} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs">
            <Login author={comment.author} />
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
        <Login author={item.author} />
        <span className={cn("text-muted-foreground", state.className)}>
          {state.label}
        </span>
        <span className="ml-auto" />
        <Timestamp iso={item.createdAt} href={item.htmlUrl} />
      </div>
      {(item.body.trim().length > 0 || item.comments.length > 0) && (
        <div className="flex flex-col gap-2 pl-10">
          {item.body.trim().length > 0 && (
            <div className={cn("callout px-3 py-2 text-[13px]", state.callout)}>
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
/* ── FILES CHANGED ──
   The PR's files (`GET /api/prs/:n/files?page=k`, paged — GitHub's
   whole-PR diff refuses anything over 20 000 lines), one card per file
   rendered by @pierre/diffs as the pages land, with the reviews' inline
   comments drawn under the lines they were left on — GitHub's "Files
   changed" tab. Cards mount when scrolled near, and a file over
   LARGE_FILE_LINES waits for a click, so a huge PR opens instantly. */

interface RenderableFile {
  file: ChangedFile;
  /** Parsed for the renderer; `undefined` when GitHub sent no hunks
   *  (binary, or this file alone too large) — a placeholder shows. */
  meta: FileDiffMetadata | undefined;
  /** This file's re-dressed diff — the fallback if rendering throws. */
  raw: string | undefined;
}

const toRenderable = (file: ChangedFile): RenderableFile => {
  const raw = toGitDiff(file);
  const meta =
    raw === undefined
      ? undefined
      : parsePatchFiles(raw).flatMap((patch) => patch.files)[0];
  return { file, meta, raw };
};

/** A file's +N −M, monospace, colored — the page's moss and brick, or
 *  the code surface's own tints when drawn `onCode`. */
const FileStat = ({
  additions,
  deletions,
  className,
  onCode = false,
}: {
  additions: number;
  deletions: number;
  className?: string;
  onCode?: boolean;
}) => (
  <span
    className={cn("shrink-0 font-mono text-[11px] tabular-nums", className)}
  >
    <span className={onCode ? "text-code-addition" : "text-moss"}>
      +{additions.toLocaleString()}
    </span>{" "}
    <span className={onCode ? "text-code-deletion" : "text-brick"}>
      −{deletions.toLocaleString()}
    </span>
  </span>
);

/** The comments that sit on ONE diff line (a thread: root + replies),
 *  drawn under it — a page-colored card set into the code surface, as
 *  GitHub draws a thread in a diff. */
const DiffLineThread = ({
  comments,
  repo,
  Markdown,
}: {
  comments: InlineComment[];
  repo: string;
  Markdown: Markdown;
}) => (
  <div className="mx-3 my-1.5 rounded-lg bg-background font-sans text-[13px] text-foreground">
    <div className="callout callout-note">
      {comments.map((comment, index) => (
        <div
          key={comment.id}
          className={cn(
            "flex items-start gap-2 px-2.5 py-2",
            index > 0 && "border-t border-inherit",
          )}
        >
          <Avatar author={comment.author} size={4} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs">
              <Login author={comment.author} />
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
      ))}
    </div>
  </div>
);

/** The inline comments still anchored on today's diff, grouped by the
 *  line they sit on, as the renderer's annotations. */
const annotationsFor = (
  path: string,
  comments: InlineComment[],
): DiffLineAnnotation<InlineComment[]>[] => {
  const byLine = new Map<string, DiffLineAnnotation<InlineComment[]>>();
  for (const comment of comments) {
    if (comment.path !== path || comment.outdated) continue;
    if (comment.line === undefined) continue;
    const side = comment.side === "LEFT" ? "deletions" : "additions";
    const key = `${side}:${comment.line}`;
    const existing = byLine.get(key);
    if (existing !== undefined) existing.metadata.push(comment);
    else {
      byLine.set(key, { side, lineNumber: comment.line, metadata: [comment] });
    }
  }
  return [...byLine.values()];
};

/** Render `children` only once the box has scrolled near the viewport
 *  (and keep it thereafter) — a 300-file PR must not mount 300 diff
 *  renderers on open. Until then the box holds `placeholder`. */
const NearViewport = ({
  placeholder,
  children,
}: {
  placeholder: ReactNode;
  children: ReactNode;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (node === null || near) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    // the margin widens the ROOT; observed against the viewport it
    // would not reach past the pane that scrolls — so observe against
    // that pane
    let root: HTMLElement | null = node.parentElement;
    while (root !== null) {
      const { overflowY } = getComputedStyle(root);
      if (overflowY === "auto" || overflowY === "scroll") break;
      root = root.parentElement;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { root, rootMargin: "800px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);
  return <div ref={ref}>{near ? children : placeholder}</div>;
};

/** The header-only stand-in for a diff not (yet) rendered: the path,
 *  its +/−, and whatever `children` says about why. */
const FileShell = ({
  file,
  children,
}: {
  file: ChangedFile;
  children?: ReactNode;
}) => (
  <div className="code-surface overflow-hidden rounded-md border text-[13px]">
    <div className="flex items-center gap-2 bg-code-foreground/5 px-3 py-1.5">
      <span className="truncate font-mono text-xs" title={file.filename}>
        {file.previousFilename !== undefined && (
          <span className="text-code-muted">{file.previousFilename} → </span>
        )}
        {file.filename}
      </span>
      <FileStat
        additions={file.additions}
        deletions={file.deletions}
        className="ml-auto"
        onCode
      />
    </div>
    {children !== undefined && (
      <div className="flex items-center justify-center gap-3 border-t border-code-border px-3 py-6 text-xs text-code-muted">
        {children}
      </div>
    )}
  </div>
);

/** A button or link drawn on the code surface. */
const ON_CODE_BUTTON =
  "inline-flex items-center gap-1 rounded-md border border-code-border bg-code-foreground/10 px-2 py-0.5 text-code-foreground hover:bg-code-foreground/20";

const ChangedFileCard = ({
  entry,
  comments,
  renderAnnotation,
}: {
  entry: RenderableFile;
  comments: InlineComment[];
  renderAnnotation: (
    annotation: DiffLineAnnotation<InlineComment[]>,
  ) => ReactNode;
}) => {
  const { file, meta, raw } = entry;
  const large = file.additions + file.deletions > LARGE_FILE_LINES;
  const [shown, setShown] = useState(!large);
  if (meta === undefined || raw === undefined) {
    return (
      <FileShell file={file}>
        {file.additions + file.deletions === 0
          ? "GitHub provided no diff for this file — a binary, or one it did not diff."
          : "This file's diff is too large for GitHub to serve."}
        <a
          href={file.blobUrl}
          target="_blank"
          rel="noreferrer"
          title={`Open ${file.filename} at the pull request's head on github.com.`}
          className={ON_CODE_BUTTON}
        >
          View file <ExternalLink className="size-3" />
        </a>
      </FileShell>
    );
  }
  if (!shown) {
    return (
      <FileShell file={file}>
        Large diff not rendered by default.
        <button
          type="button"
          onClick={() => setShown(true)}
          title={`Render this file's diff — ${(file.additions + file.deletions).toLocaleString()} changed lines, more than the ${LARGE_FILE_LINES.toLocaleString()} rendered without asking.`}
          className={ON_CODE_BUTTON}
        >
          Load diff
        </button>
      </FileShell>
    );
  }
  return (
    <NearViewport placeholder={<FileShell file={file} />}>
      <FileDiffCard
        file={meta}
        fallback={raw}
        annotations={annotationsFor(file.filename, comments)}
        renderAnnotation={renderAnnotation}
      />
    </NearViewport>
  );
};

const PullRequestFiles = ({
  number,
  headSha,
  repo,
  comments,
  Markdown,
}: {
  number: number;
  /** The PR's head as last polled. A new head is a new diff — but it
   *  is NOT swapped in under the reader: the diff shown stays put and
   *  a bar offers the refresh (GitHub's), so a place in a long file is
   *  never lost to a push. */
  headSha: string;
  repo: string;
  /** Every inline comment on the PR, any review. */
  comments: InlineComment[];
  Markdown: Markdown;
}) => {
  // what to load: the head as of the last (re)load — `epoch` makes a
  // refresh onto the same sha (a failed load, retried) a new load too
  const [load, setLoad] = useState({ sha: headSha, epoch: 0 });
  const [state, setState] = useState<{
    files: RenderableFile[];
    /** Pages still landing. */
    loading: boolean;
    error: string | undefined;
  }>({ files: [], loading: true, error: undefined });

  useEffect(() => {
    const controller = new AbortController();
    setState({ files: [], loading: true, error: undefined });
    fetchChangedFiles(
      number,
      (page) =>
        setState((prev) => ({
          ...prev,
          files: [...prev.files, ...page.files.map(toRenderable)],
          loading: page.next !== null,
        })),
      controller.signal,
    ).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setState((prev) => ({
        ...prev,
        loading: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }));
    });
    return () => controller.abort();
  }, [number, load]);

  const { files, loading, error } = state;
  const stale = load.sha !== headSha;
  const refresh = () => setLoad({ sha: headSha, epoch: load.epoch + 1 });
  const refreshBar = stale && (
    <div
      role="status"
      className="callout callout-note flex items-center gap-2 px-3 py-1.5 text-xs"
    >
      <span className="min-w-0 flex-1">
        New changes were pushed — this diff is of{" "}
        <span className="font-mono">{load.sha.slice(0, 7)}</span>, the pull
        request is now at{" "}
        <span className="font-mono">{headSha.slice(0, 7)}</span>.
      </span>
      <button
        type="button"
        onClick={refresh}
        title={`Refresh — reload the diff at ${headSha.slice(0, 7)}. The files re-render, so your place in them is lost.`}
        className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-foreground shadow-xs hover:bg-accent"
      >
        <RefreshCw className="size-3" /> Refresh
      </button>
    </div>
  );

  const cards = useRef(new Map<string, HTMLDivElement>());
  const jumpTo = (name: string) =>
    cards.current.get(name)?.scrollIntoView({ block: "start" });

  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<InlineComment[]>) => (
      <DiffLineThread
        comments={annotation.metadata}
        repo={repo}
        Markdown={Markdown}
      />
    ),
    [repo, Markdown],
  );

  if (files.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {refreshBar}
        {error !== undefined ? (
          <div className="py-4 font-mono text-[11px] text-brick">
            diff failed: {error}
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner className="size-4" /> Loading diff…
          </div>
        ) : (
          <div className="py-8 text-center text-xs text-muted-foreground">
            No changes.
          </div>
        )}
      </div>
    );
  }

  const total = files.reduce(
    (sum, { file }) => ({
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );

  return (
    <div className="flex flex-col gap-4">
      {refreshBar}
      {/* the file list — GitHub's summary: every path, its +/−, a jump */}
      <div className="rounded-lg border border-border bg-background">
        <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5 text-xs">
          <span className="font-medium">
            {files.length} file{files.length === 1 ? "" : "s"} changed
          </span>
          {loading && (
            <span
              className="flex items-center gap-1 text-muted-foreground"
              aria-live="polite"
            >
              <Spinner className="size-3" /> loading more…
            </span>
          )}
          {error !== undefined && (
            <span className="font-mono text-[11px] text-brick">
              diff incomplete: {error}
            </span>
          )}
          <FileStat
            additions={total.additions}
            deletions={total.deletions}
            className="ml-auto"
          />
        </div>
        <ul
          aria-label="changed files"
          className="max-h-64 overflow-y-auto py-1 text-xs"
        >
          {files.map(({ file }) => (
            <li key={file.filename}>
              <button
                type="button"
                onClick={() => jumpTo(file.filename)}
                title={`Jump to ${file.filename} (+${file.additions} −${file.deletions}).`}
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-1 text-left hover:bg-accent/70"
              >
                <span className="truncate font-mono">
                  {file.previousFilename !== undefined && (
                    <span className="text-muted-foreground">
                      {file.previousFilename} →{" "}
                    </span>
                  )}
                  {file.filename}
                </span>
                <FileStat
                  additions={file.additions}
                  deletions={file.deletions}
                />
              </button>
            </li>
          ))}
        </ul>
      </div>

      {files.map((entry) => (
        <div
          key={entry.file.filename}
          ref={(node) => {
            if (node) cards.current.set(entry.file.filename, node);
            else cards.current.delete(entry.file.filename);
          }}
          data-changed-file={entry.file.filename}
          className="scroll-mt-2"
        >
          <ChangedFileCard
            entry={entry}
            comments={comments}
            renderAnnotation={renderAnnotation}
          />
        </div>
      ))}
    </div>
  );
};

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
  onReviseProposal,
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
   *  newest first (src/github/Proposals.ts). */
  proposals?: Proposal[];
  proposalBusy?: ReadonlySet<string>;
  onAcceptProposal?: (id: string) => void;
  onRejectProposal?: (id: string, reason: string | undefined) => void;
  onReviseProposal?: (id: string, message: string) => void;
  /** Open a session's thread by `${term}:${key}`. */
  onOpenSession?: (id: string) => void;
}) => {
  const [view, setView] = useState<PullRequestView | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  // Conversation | Files changed | Proposals — the URL carries the
  // pick (`/o/r/pull/n/files`, `/proposals`) so a reload or a shared
  // link lands on it.
  const [tab, setTab] = useState<OverviewTab>(() =>
    active ? tabFromLocation() : "conversation",
  );
  // Every tab STAYS mounted once shown (hidden, not unmounted): coming
  // back to Files changed finds the diff as it was — fetched once,
  // rendered once, scrolled to where the reader left it. The files
  // tab alone mounts lazily, so opening a PR does not fetch its diff.
  const [filesMounted, setFilesMounted] = useState(tab === "files");
  const scroller = useRef<HTMLDivElement>(null);
  // each tab's scroll offset, kept while another is shown
  const scrollTops = useRef<Partial<Record<OverviewTab, number>>>({});
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const showTab = useCallback((next: OverviewTab) => {
    // read the offset NOW, synchronously — a scroll event would only
    // report it a frame later, by which time the switch has clamped
    // the pane to the next tab's height and the place is gone
    const node = scroller.current;
    if (node !== null) scrollTops.current[tabRef.current] = node.scrollTop;
    if (next === "files") setFilesMounted(true);
    setTab(next);
  }, []);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node !== null) node.scrollTop = scrollTops.current[tab] ?? 0;
  }, [tab]);
  const pickTab = (next: OverviewTab) => {
    showTab(next);
    if (active) {
      window.history.replaceState(
        null,
        "",
        withTab(window.location.pathname, next),
      );
    }
  };
  useEffect(() => {
    if (!active) return;
    // shown (again) — the URL that brought us here picks the tab, e.g.
    // a notification's jump lands on `/proposals`; …as do back/forward
    // and in-app navigation while shown, as long as the location is
    // still this PR's (leaving must not disturb the tab)
    const own = pathOf(overviewId(`${repo}#${number}`));
    const sync = () => {
      const { pathname } = window.location;
      if (pathname === own || pathname.startsWith(`${own}/`)) {
        showTab(tabFromLocation());
      }
    };
    sync();
    window.addEventListener("popstate", sync);
    window.addEventListener(NAVIGATE_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAVIGATE_EVENT, sync);
    };
  }, [active, repo, number, showTab]);

  const sortedProposals = useMemo(
    () =>
      [...(proposals ?? [])].sort(
        (a, b) =>
          Number(b.status === "pending") - Number(a.status === "pending") ||
          b.at - a.at,
      ),
    [proposals],
  );
  const pendingProposals = sortedProposals.filter(
    (proposal) => proposal.status === "pending",
  );
  // stable across polls that change nothing, so the diff cards' props
  // hold still between the 15s refreshes
  const timeline = view?.timeline;
  const inlineComments = useMemo(
    () =>
      timeline?.flatMap((item) =>
        item.kind === "review" ? item.comments : [],
      ) ?? [],
    [timeline],
  );

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
            // a poll that changed nothing keeps the same object, so
            // nothing below re-renders for it
            setView((prev) =>
              prev !== undefined &&
              JSON.stringify(prev) === JSON.stringify(data)
                ? prev
                : data,
            );
            setError(undefined);
          }
        })
        .catch((cause: unknown) => {
          if (live) setError(String(cause));
        });
    load();
    const timer = setInterval(load, active ? 15_000 : 60_000);
    // coming back to the window is the moment to be current — a push
    // made while away shows up (as the Files changed refresh bar) at
    // once, not up to a poll later
    const onReturn = () => {
      if (active && document.visibilityState === "visible") load();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
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
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
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
              title={`Open pull request #${view.number} on github.com in a new tab.`}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground shadow-xs hover:bg-accent"
            >
              Open on GitHub <ExternalLink className="size-3" />
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
              <Login author={view.author} />
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
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-1.5 text-xs">
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-muted-foreground">machine</span>
          <span className="min-w-0 flex-1 truncate [&>span]:inline">
            {machine.phase === "idle" && (
              <span
                className="text-muted-foreground"
                title={`Idle — the first thread or terminal checks out ${view.checkoutRef} on it.`}
              >
                idle — a thread or terminal checks out{" "}
                <span className="font-mono text-foreground">
                  {view.checkoutRef}
                </span>{" "}
                first.
              </span>
            )}
            {machine.phase === "checking-out" && (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Spinner className="size-3" /> waking the machine and checking
                out{" "}
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
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              title={`Pull — fetch the pull request's head (${view.checkoutRef}) onto the machine again, so its checkout is current.`}
              disabled={machine.phase === "checking-out"}
              onClick={onCheckout}
              className="flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground shadow-xs hover:bg-accent disabled:opacity-50"
            >
              <RefreshCw className="size-3" /> pull
            </button>
            <button
              type="button"
              title="New thread — start an agent (an Engineer) on this pull request's machine, in a new tab beside this one."
              onClick={onNewThread}
              className="flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground shadow-xs hover:bg-accent"
            >
              <MessageSquare className="size-3" /> thread
            </button>
            <button
              type="button"
              title="New terminal — open a shell on this pull request's machine, checked out at its head, in a new tab beside this one."
              onClick={onNewTerminal}
              className="flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground shadow-xs hover:bg-accent"
            >
              <SquareTerminal className="size-3" /> terminal
            </button>
            {review.status === "none" && (
              <button
                type="button"
                disabled={review.requested || review.unavailable}
                title={
                  review.unavailable
                    ? "Request review — unavailable: the review bot is not deployed here."
                    : review.requested
                      ? "Request review — asked; the bot's session is starting."
                      : "Request review — the review bot reads the diff and proposes comments and a verdict for you to accept under Proposals."
                }
                onClick={onRequestReview}
                className="flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground shadow-xs hover:bg-accent disabled:opacity-50"
              >
                <MessageSquareText className="size-3" />
                {review.requested ? "requesting…" : "request review"}
              </button>
            )}
            {review.status === "session" && review.running && (
              <span className="flex items-center gap-1 px-1 text-xs text-moss">
                <span className="size-1.5 animate-pulse rounded-full bg-moss" />
                reviewing
              </span>
            )}
          </span>
        </div>

        {/* ── Conversation | Files changed | Proposals ── */}
        <div
          role="tablist"
          aria-label="pull request views"
          // sticky: reachable from anywhere in a long diff, so switching
          // tabs never needs a scroll to the top (and back)
          className="sticky top-0 z-10 -mb-1 flex items-center gap-1 border-b border-border bg-background text-[13px]"
        >
          {(
            [
              {
                id: "conversation",
                icon: MessageSquare,
                label: "Conversation",
                count: view.timeline.length,
                attention: false,
                title: `Conversation — the description, then ${view.timeline.length} comment${view.timeline.length === 1 ? "" : "s"} and review${view.timeline.length === 1 ? "" : "s"} as on GitHub.`,
              },
              {
                id: "files",
                icon: FileDiffIcon,
                label: "Files changed",
                count: view.changedFiles,
                attention: false,
                title: `Files changed — the diff of ${view.changedFiles} file${view.changedFiles === 1 ? "" : "s"}, with the reviews' inline comments on their lines.`,
              },
              {
                id: "proposals",
                icon: Sparkles,
                label: "Proposals",
                // the badge counts what AWAITS the operator; the tab
                // itself holds every proposal, resolved ones too
                count: pendingProposals.length,
                attention: pendingProposals.length > 0,
                title:
                  pendingProposals.length === 0
                    ? "Proposals — what the agents proposed to do on this pull request (comments, verdicts, merges); nothing awaits you."
                    : `Proposals — ${pendingProposals.length} awaiting your accept or decline.`,
              },
            ] as const
          ).map(({ id, icon: Icon, label, count, attention, title }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              title={title}
              onClick={() => pickTab(id)}
              className={cn(
                "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-muted-foreground hover:text-foreground",
                tab === id
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent",
              )}
            >
              <Icon className="size-3.5" />
              {label}
              <span
                className={cn(
                  "rounded-full px-1.5 font-mono text-[10px] tabular-nums leading-4",
                  attention
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {count}
              </span>
            </button>
          ))}
        </div>

        {/* the panels: `hidden`, never unmounted, once shown (see
            filesMounted) — so switching tabs neither refetches nor
            re-renders, and the offset each was scrolled to is kept */}
        {filesMounted && (
          <div
            role="tabpanel"
            aria-label="files changed"
            hidden={tab !== "files"}
          >
            <PullRequestFiles
              number={number}
              headSha={view.head.sha}
              repo={view.repo}
              comments={inlineComments}
              Markdown={Markdown}
            />
          </div>
        )}

        {/* ── PROPOSALS: what the agents want to do here, awaiting the
            operator's click (pending first), then what became of the
            rest — the record of the bot's hand on this pull request ── */}
        <div
          role="tabpanel"
          aria-label="proposals on this pull request"
          hidden={tab !== "proposals"}
          className="flex flex-col gap-2"
        >
          {sortedProposals.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              No proposals yet — an agent reviewing this pull request will
              propose its comments, verdict, or merge here for you to accept.
            </div>
          ) : (
            <div className="text-xs font-medium text-muted-foreground">
              {pendingProposals.length === 0
                ? "Nothing awaiting you."
                : `${pendingProposals.length} awaiting you`}
              {sortedProposals.length > pendingProposals.length &&
                ` · ${sortedProposals.length - pendingProposals.length} resolved`}
            </div>
          )}
          {sortedProposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              Markdown={Markdown}
              busy={proposalBusy?.has(proposal.id) ?? false}
              onAccept={() => onAcceptProposal?.(proposal.id)}
              onReject={(reason) => onRejectProposal?.(proposal.id, reason)}
              onRevise={(message) => onReviseProposal?.(proposal.id, message)}
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

        {/* ── the conversation: the description at full width, then
            the timeline in GitHub's gutter geometry ── */}
        <div
          role="tabpanel"
          aria-label="conversation"
          hidden={tab !== "conversation"}
          className="flex flex-col gap-4"
        >
          <CommentCard
            author={view.author}
            createdAt={view.createdAt}
            htmlUrl={view.htmlUrl}
            body={view.body}
            repo={view.repo}
            Markdown={Markdown}
            heading="opened this pull request"
            gutter={false}
          />
          {view.timeline.length > 0 ? (
            <div className={cn("relative flex flex-col gap-4", GUTTER)}>
              {/* the connector, drawn once behind the whole column */}
              <div
                aria-hidden
                className={cn(
                  "absolute top-4 bottom-4 w-0.5 bg-border/60",
                  LINE_LEFT,
                )}
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
          ) : (
            <div className="py-2 text-center text-xs text-muted-foreground">
              No comments yet.
            </div>
          )}
        </div>
        {error !== undefined && (
          <div className="font-mono text-[11px] text-brick">
            refresh failed: {error}
          </div>
        )}
      </div>
    </div>
  );
};
