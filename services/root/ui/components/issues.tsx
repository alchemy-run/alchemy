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
  patchIssue,
  type ForgeComment,
  type ForgeIssue,
  type SeedStatus,
} from "@/lib/forge";
import { showWork, type WorkPlace } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { GitStatusEntry } from "@pierre/trees";
import {
  ArrowLeft,
  CheckCircle2,
  CircleDot,
  FolderGit2,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  FileDiff as FileDiffIcon,
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
        <span className="text-muted-foreground">
          commented {age(when)} ago
        </span>
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
      const status: GitStatusEntry["status"] = /^new file mode /m.test(
        fallback,
      )
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
          style={{ height: "calc(100dvh - 260px)" }}
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
  const [diff, setDiff] = useState<
    { ok: boolean; text: string } | undefined
  >();

  const reload = () => {
    fetchIssue(repo, number).then(setIssue).catch(() => {});
    fetchComments(repo, number).then(setComments).catch(() => {});
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
                <MarkdownText text={issue.body ?? "*No description provided.*"} />
              </TimelineComment>
              {comments.map((comment) => (
                <TimelineComment
                  key={comment.id}
                  author={comment.user.login}
                  when={comment.created_at}
                  origin={comment.id < 0 ? "local" : "github"}
                >
                  <MarkdownText text={comment.body} />
                </TimelineComment>
              ))}

              {/* the comment box — avatar on the line, actions right */}
              <div className="relative flex gap-3 pt-2">
                <div className="z-[1] shrink-0 pt-0.5">
                  <Avatar name={HUMAN.name} kind="human" size={32} />
                </div>
                <div className="min-w-0 flex-1 rounded-md border border-border">
                  <div className="border-b border-border/70 bg-muted/40 px-3 py-1.5 text-xs font-semibold">
                    Add a comment
                  </div>
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="Leave a comment"
                    rows={4}
                    className="w-full resize-y bg-transparent px-3.5 py-2.5 text-sm outline-none"
                  />
                  <div className="flex items-center justify-end gap-2 border-t border-border/50 px-3 py-2">
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
