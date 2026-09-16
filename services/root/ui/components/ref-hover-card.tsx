import {
  BadgeCheck,
  CircleCheck,
  CircleDot,
  CircleSlash,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";

export interface RefInfo {
  readonly kind: "issue" | "pr";
  readonly state: "open" | "closed" | "merged" | "draft";
  readonly title: string;
  readonly author: string;
  readonly avatar: string;
  readonly updatedAt: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changedFiles?: number;
}

const cache = new Map<string, Promise<RefInfo | undefined>>();

const fetchRef = (
  repo: string,
  number: number,
): Promise<RefInfo | undefined> => {
  const key = `${repo}#${number}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const promise = (async (): Promise<RefInfo | undefined> => {
    const issue = await fetch(
      `https://api.github.com/repos/${repo}/issues/${number}`,
      { headers: { accept: "application/vnd.github+json" } },
    );
    if (!issue.ok) return undefined;
    const data = (await issue.json()) as any;
    const isPr = data.pull_request !== undefined;
    const base: Omit<RefInfo, "kind" | "state"> = {
      title: String(data.title ?? ""),
      author: String(data.user?.login ?? ""),
      avatar: String(data.user?.avatar_url ?? ""),
      updatedAt: String(data.updated_at ?? data.created_at ?? ""),
    };
    if (!isPr) {
      return {
        ...base,
        kind: "issue",
        state: data.state === "open" ? "open" : "closed",
      };
    }
    const pull = await fetch(
      `https://api.github.com/repos/${repo}/pulls/${number}`,
      { headers: { accept: "application/vnd.github+json" } },
    );
    if (!pull.ok) {
      return {
        ...base,
        kind: "pr",
        state: data.state === "open" ? "open" : "closed",
      };
    }
    const pr = (await pull.json()) as any;
    return {
      ...base,
      kind: "pr",
      state: pr.merged
        ? "merged"
        : pr.draft
          ? "draft"
          : pr.state === "open"
            ? "open"
            : "closed",
      additions: Number(pr.additions ?? 0),
      deletions: Number(pr.deletions ?? 0),
      changedFiles: Number(pr.changed_files ?? 0),
    };
  })().catch(() => undefined);
  cache.set(key, promise);
  return promise;
};

export interface CommitInfo {
  readonly sha: string;
  /** First line of the message. */
  readonly subject: string;
  /** The rest of the message (may be empty). */
  readonly body: string;
  readonly author: string;
  readonly avatar: string;
  readonly authoredAt: string;
  readonly verified: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly parents: number;
}

const commitCache = new Map<string, Promise<CommitInfo | undefined>>();

const fetchCommit = (
  repo: string,
  sha: string,
): Promise<CommitInfo | undefined> => {
  const key = `${repo}@${sha}`;
  const cached = commitCache.get(key);
  if (cached !== undefined) return cached;
  const promise = (async (): Promise<CommitInfo | undefined> => {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/commits/${sha}`,
      { headers: { accept: "application/vnd.github+json" } },
    );
    if (!response.ok) return undefined;
    const data = (await response.json()) as any;
    const message = String(data.commit?.message ?? "");
    const [subject = "", ...rest] = message.split("\n");
    return {
      sha: String(data.sha ?? sha),
      subject,
      body: rest.join("\n").trim(),
      // the GitHub account when the email resolved, else the git author
      author: String(data.author?.login ?? data.commit?.author?.name ?? ""),
      avatar: String(data.author?.avatar_url ?? ""),
      authoredAt: String(
        data.commit?.author?.date ?? data.commit?.committer?.date ?? "",
      ),
      verified: data.commit?.verification?.verified === true,
      additions: Number(data.stats?.additions ?? 0),
      deletions: Number(data.stats?.deletions ?? 0),
      changedFiles: Array.isArray(data.files) ? data.files.length : 0,
      parents: Array.isArray(data.parents) ? data.parents.length : 1,
    };
  })().catch(() => undefined);
  commitCache.set(key, promise);
  return promise;
};

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
  RefInfo["kind"],
  Record<
    RefInfo["state"],
    { icon: typeof CircleDot; label: string; className: string }
  >
> = {
  issue: {
    open: { icon: CircleDot, label: "Open", className: "bg-moss/15 text-moss" },
    closed: {
      icon: CircleCheck,
      label: "Closed",
      className: "bg-terracotta/15 text-terracotta",
    },
    merged: {
      icon: CircleCheck,
      label: "Closed",
      className: "bg-terracotta/15 text-terracotta",
    },
    draft: {
      icon: CircleSlash,
      label: "Draft",
      className: "bg-muted text-muted-foreground",
    },
  },
  pr: {
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
  },
};

const CardBody = ({
  repo,
  number,
  href,
}: {
  repo: string;
  number: number;
  href: string;
}) => {
  const [info, setInfo] = useState<RefInfo | undefined | "loading">("loading");
  useEffect(() => {
    let live = true;
    void fetchRef(repo, number).then((result) => {
      if (live) setInfo(result);
    });
    return () => {
      live = false;
    };
  }, [repo, number]);

  if (info === "loading") {
    return (
      <div className="animate-pulse space-y-2">
        <div className="h-4 w-24 rounded bg-muted" />
        <div className="h-4 w-56 rounded bg-muted" />
        <div className="h-4 w-32 rounded bg-muted" />
      </div>
    );
  }
  if (info === undefined) {
    return (
      <div className="font-mono text-xs text-muted-foreground">
        {repo}#{number}
      </div>
    );
  }
  const pill = STATE_PILL[info.kind][info.state];
  const PillIcon = pill.icon;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
            pill.className,
          )}
        >
          <PillIcon className="size-3.5" />
          {pill.label}
        </span>
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 truncate font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          {repo} #{number}
        </a>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {relativeTime(info.updatedAt)}
        </span>
      </div>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="block text-sm font-semibold leading-snug hover:text-primary hover:underline"
      >
        {info.title}
      </a>
      <div className="flex items-center gap-2">
        {info.avatar && (
          <img
            src={info.avatar}
            alt={info.author}
            className="size-4 rounded-full"
          />
        )}
        <span className="text-xs text-muted-foreground">{info.author}</span>
        {info.kind === "pr" && info.additions !== undefined && (
          <DiffChips
            additions={info.additions}
            deletions={info.deletions ?? 0}
            changedFiles={info.changedFiles ?? 0}
          />
        )}
      </div>
    </div>
  );
};

/**
 * GitHub-style hover preview for issue/PR references: state pill,
 * repo#number, relative time, title, author + avatar, and (for PRs)
 * `+adds −dels` / file-count chips. Metadata is fetched lazily from
 * the public GitHub API on first hover and cached for the session.
 *
 * Wrap a ref link: hovering shows the GitHub preview card. `repo` is
 * `owner/name`; the trigger renders your children unchanged.
 */
export const RefHoverCard = ({
  repo,
  number,
  children,
}: {
  repo: string;
  number: number;
  children: ReactNode;
}) => (
  <HoverCard openDelay={250}>
    <HoverCardTrigger asChild>{children}</HoverCardTrigger>
    <HoverCardContent
      align="start"
      className="w-96 max-w-[calc(100vw-2rem)] rounded-lg border-border bg-popover p-3 shadow-lg"
    >
      <CardBody
        repo={repo}
        number={number}
        href={`https://github.com/${repo}/issues/${number}`}
      />
    </HoverCardContent>
  </HoverCard>
);

const DiffChips = ({
  additions,
  deletions,
  changedFiles,
}: {
  additions: number;
  deletions: number;
  changedFiles: number;
}) => (
  <span className="ml-auto flex items-center gap-1.5">
    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
      <span className="text-moss">+{additions.toLocaleString()}</span>{" "}
      <span className="text-brick">−{deletions.toLocaleString()}</span>
    </span>
    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
      {changedFiles} {changedFiles === 1 ? "file" : "files"}
    </span>
  </span>
);

const CommitCardBody = ({
  repo,
  sha,
  href,
}: {
  repo: string;
  sha: string;
  href: string;
}) => {
  const [info, setInfo] = useState<CommitInfo | undefined | "loading">(
    "loading",
  );
  useEffect(() => {
    let live = true;
    void fetchCommit(repo, sha).then((result) => {
      if (live) setInfo(result);
    });
    return () => {
      live = false;
    };
  }, [repo, sha]);

  if (info === "loading") {
    return (
      <div className="animate-pulse space-y-2">
        <div className="h-4 w-24 rounded bg-muted" />
        <div className="h-4 w-56 rounded bg-muted" />
        <div className="h-4 w-32 rounded bg-muted" />
      </div>
    );
  }
  if (info === undefined) {
    return (
      <div className="font-mono text-xs text-muted-foreground">
        {repo}@{sha.slice(0, 7)}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          <GitCommitHorizontal className="size-3.5" />
          {info.parents > 1 ? "Merge" : "Commit"}
        </span>
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 truncate font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          {repo}@{info.sha.slice(0, 7)}
        </a>
        {info.verified && (
          <span
            title="Signature verified"
            className="flex shrink-0 items-center gap-1 rounded-full bg-moss/15 px-2 py-0.5 text-xs font-medium text-moss"
          >
            <BadgeCheck className="size-3.5" />
            Verified
          </span>
        )}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {relativeTime(info.authoredAt)}
        </span>
      </div>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="block text-sm font-semibold leading-snug hover:text-primary hover:underline"
      >
        {info.subject}
      </a>
      {info.body && (
        <p className="line-clamp-3 whitespace-pre-line text-xs leading-snug text-muted-foreground">
          {info.body}
        </p>
      )}
      <div className="flex items-center gap-2">
        {info.avatar && (
          <img
            src={info.avatar}
            alt={info.author}
            className="size-4 rounded-full"
          />
        )}
        <span className="text-xs text-muted-foreground">{info.author}</span>
        <DiffChips
          additions={info.additions}
          deletions={info.deletions}
          changedFiles={info.changedFiles}
        />
      </div>
    </div>
  );
};

/**
 * GitHub-style hover preview for a commit: `repo@sha`, verified badge,
 * relative time, subject, the message body (clamped), author + avatar,
 * and `+adds −dels` / file-count chips. Fetched lazily from the public
 * GitHub API on first hover and cached for the session.
 */
export const CommitHoverCard = ({
  repo,
  sha,
  children,
}: {
  repo: string;
  sha: string;
  children: ReactNode;
}) => (
  <HoverCard openDelay={250}>
    <HoverCardTrigger asChild>{children}</HoverCardTrigger>
    <HoverCardContent
      align="start"
      className="w-96 max-w-[calc(100vw-2rem)] rounded-lg border-border bg-popover p-3 shadow-lg"
    >
      <CommitCardBody
        repo={repo}
        sha={sha}
        href={`https://github.com/${repo}/commit/${sha}`}
      />
    </HoverCardContent>
  </HoverCard>
);
