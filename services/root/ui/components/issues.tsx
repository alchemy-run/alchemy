/**
 * ISSUES and PULLS — the org's work, from its own mirror
 * (`/issues/:repo[/:number]`, `/pulls/:repo[/:number]`).
 *
 * One surface, two kinds: the list (state filter, comment counts,
 * origin) and the item (body + comments as documents, comment
 * composer, close/reopen). Issues can be CREATED here — filed in
 * the org's store, no GitHub involved; pulls arrive from the mirror
 * (and, soon, from the agents' own forge pushes).
 */
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
  patchIssue,
  type ForgeComment,
  type ForgeIssue,
  type SeedStatus,
} from "@/lib/forge";
import { parsePatchFiles } from "@pierre/diffs";
import { showWork, type WorkPlace } from "@/lib/routes";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  CheckCircle2,
  CircleDot,
  FolderGit2,
  GitMerge,
  GitPullRequest,
  MessageSquare,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const PROSE =
  "text-[14px] leading-relaxed [&_p]:my-2.5 [&_p:first-child]:mt-0 " +
  "[&_ul]:my-2 [&_li]:my-0.5 [&_pre]:my-3";

const age = (iso: string): string => {
  const ms = Date.now() - Date.parse(iso);
  const days = Math.floor(ms / 86_400_000);
  if (days > 365) return `${Math.floor(days / 365)}y`;
  if (days > 0) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  return hours > 0 ? `${hours}h` : `${Math.max(1, Math.floor(ms / 60_000))}m`;
};

const StateBadge = ({ issue }: { issue: ForgeIssue }) => {
  const isPull = issue.pull_request !== undefined;
  const merged = isPull && issue.pull_request!.merged_at !== null;
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

/** The pull's FILES CHANGED — @pierre/diffs end to end: the unified
 *  diff parsed (`parsePatchFiles`) and each file rendered by
 *  `FileDiffCard` (Shiki, word-level inline highlights, hunk
 *  separators). */
const PullFiles = ({ repo, number }: { repo: string; number: number }) => {
  const [diff, setDiff] = useState<
    { ok: boolean; text: string } | undefined
  >();
  useEffect(() => {
    let alive = true;
    fetchPullDiff(repo, number)
      .then((body) => {
        if (alive) setDiff(body);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repo, number]);

  const parsed = useMemo(() => {
    if (diff === undefined || !diff.ok) return [];
    try {
      const files = parsePatchFiles(diff.text).flatMap(
        (patch) => patch.files,
      );
      const raw = splitPatchFiles(diff.text);
      return files.map((file, index) => ({
        file,
        fallback: raw[index] ?? diff.text,
      }));
    } catch {
      return [];
    }
  }, [diff]);

  if (diff === undefined) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        loading the diff…
      </div>
    );
  }
  if (!diff.ok) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        no diff to show — this pull has no local source yet
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {parsed.map((entry, index) => (
        <FileDiffCard
          key={index}
          file={entry.file}
          fallback={entry.fallback}
        />
      ))}
      {parsed.length === 0 && (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap p-2 font-mono text-[11px]">
          {diff.text}
        </pre>
      )}
    </div>
  );
};

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
  /** The pull's sections: the talk, or the change itself. */
  const [section, setSection] = useState<"conversation" | "files">(
    "conversation",
  );

  const reload = () => {
    fetchIssue(repo, number).then(setIssue).catch(() => {});
    fetchComments(repo, number).then(setComments).catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [repo, number]);
  useEffect(() => setSection("conversation"), [repo, number]);

  if (issue === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        loading #{number}…
      </div>
    );
  }

  const pull = issue.pull_request;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-border px-6 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => showWork(kind, repo)}
            aria-label="back to the list"
            className="flex size-6 cursor-pointer items-center justify-center rounded hover:bg-accent"
          >
            <ArrowLeft className="size-3.5" />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold">
            {issue.title}
            <span className="ml-2 font-normal text-muted-foreground">
              #{issue.number}
            </span>
          </h1>
          <StateBadge issue={issue} />
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              patchIssue(repo, number, {
                state: issue.state === "open" ? "closed" : "open",
              })
                .then(() => reload())
                .finally(() => setBusy(false));
            }}
            className="cursor-pointer rounded-md border border-border/60 px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-50"
          >
            {issue.state === "open" ? "Close" : "Reopen"}
          </button>
        </div>
        <div className="mt-1 flex items-center gap-2 pl-8 text-xs text-muted-foreground">
          <span className="font-mono">@{issue.user.login}</span>
          <span>opened {age(issue.created_at)} ago</span>
          {pull !== undefined && pull.head_ref !== null && (
            <span className="font-mono">
              {pull.head_ref} → {pull.base_ref ?? "main"}
            </span>
          )}
        </div>
        {pull !== undefined && (
          <nav
            aria-label="pull sections"
            className="mt-2 flex items-center gap-1 pl-8"
          >
            {(["conversation", "files"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-current={section === option ? "page" : undefined}
                onClick={() => setSection(option)}
                className={cn(
                  "cursor-pointer rounded-md px-2 py-0.5 text-xs capitalize",
                  section === option
                    ? "bg-accent font-semibold"
                    : "text-muted-foreground hover:bg-accent/60",
                )}
              >
                {option === "files" ? "Files changed" : "Conversation"}
              </button>
            ))}
          </nav>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {pull !== undefined && section === "files" ? (
          <div className="w-full max-w-5xl">
            <PullFiles repo={repo} number={number} />
          </div>
        ) : (
        <div className="w-full max-w-2xl">
          <article className={cn("pb-4", PROSE)}>
            <MarkdownText text={issue.body ?? "*no description*"} />
          </article>
          {comments.map((comment) => (
            <div
              key={comment.id}
              className="mt-3 rounded-md border border-border/60"
            >
              <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 text-xs text-muted-foreground">
                <span className="font-mono">@{comment.user.login}</span>
                <span>{age(comment.created_at)} ago</span>
              </div>
              <div className={cn("px-3 py-2", PROSE)}>
                <MarkdownText text={comment.body} />
              </div>
            </div>
          ))}
          {/* the composer — a comment into the org's own store */}
          <div className="mt-4 flex flex-col gap-2">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Leave a comment…"
              rows={3}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <button
              type="button"
              disabled={busy || draft.trim().length === 0}
              onClick={() => {
                setBusy(true);
                addIssueComment(repo, number, draft)
                  .then(() => {
                    setDraft("");
                    reload();
                  })
                  .finally(() => setBusy(false));
              }}
              className="self-end cursor-pointer rounded-md border border-border/60 px-3 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              Comment
            </button>
          </div>
        </div>
        )}
      </div>
    </div>
  );
};

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
    fetchRepos().then(setRepos).catch(() => {});
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
              className="ml-auto cursor-pointer rounded-md border border-moss/50 bg-moss/10 px-2.5 py-0.5 text-xs font-medium hover:bg-moss/20"
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
              className="self-start cursor-pointer rounded-md border border-moss/50 bg-moss/10 px-3 py-1 text-xs font-medium hover:bg-moss/20 disabled:opacity-50"
            >
              File it
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
