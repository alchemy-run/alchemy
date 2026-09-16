/**
 * CODE — the forge's repositories, browsed (`/code/:repo/:ref/*path`).
 *
 * Left: the org's repos (the seeded mirrors) and the branch. Center:
 * the tree at the path, or the file — plus the recent history under
 * the root. Everything reads the embedded git server's REST plane.
 */
import {
  fetchBranches,
  fetchFile,
  fetchLog,
  fetchRepos,
  fetchTree,
  isDirectory,
  type CommitInfo,
  type SeedStatus,
  type TreeEntry,
} from "@/lib/forge";
import { showCode, type CodePlace } from "@/lib/routes";
import { cn } from "@/lib/utils";
import {
  ChevronRight,
  File,
  Folder,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
} from "lucide-react";
import { useEffect, useState } from "react";

/** The tree oid at a path, walked from the commit's root tree. */
const resolveTree = async (
  repo: string,
  rootTree: string,
  path: string,
): Promise<{ entries: ReadonlyArray<TreeEntry> } | { file: true }> => {
  let oid = rootTree;
  const parts = path.split("/").filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    const entries = await fetchTree(repo, oid);
    const entry = entries.find((candidate) => candidate.name === parts[index]);
    if (entry === undefined) return { entries: [] };
    if (!isDirectory(entry)) return { file: true };
    oid = entry.oid;
  }
  return { entries: await fetchTree(repo, oid) };
};

const short = (oid: string): string => oid.slice(0, 7);

export const CodeBrowser = ({ place }: { place: CodePlace }) => {
  const { repo, ref, path } = place;
  const [repos, setRepos] = useState<ReadonlyArray<SeedStatus>>([]);
  const [branches, setBranches] = useState<ReadonlyArray<string>>([]);
  const [tip, setTip] = useState<CommitInfo | undefined>();
  const [entries, setEntries] = useState<ReadonlyArray<TreeEntry>>([]);
  const [file, setFile] = useState<string | undefined>();
  const [log, setLog] = useState<ReadonlyArray<CommitInfo>>([]);

  useEffect(() => {
    fetchRepos().then(setRepos).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    fetchBranches(repo)
      .then((body) =>
        setBranches(
          body.refs.map((entry) => entry.name.replace("refs/heads/", "")),
        ),
      )
      .catch(() => {});
    fetchLog(repo, ref, 20)
      .then((items) => {
        if (!alive) return;
        setLog(items);
        setTip(items[0]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repo, ref]);

  // the path names a file when the last segment has an extension-ish
  // look — but truth comes from the walk: try the tree, fall back to
  // the file fetch
  useEffect(() => {
    if (tip === undefined) return;
    let alive = true;
    setFile(undefined);
    resolveTree(repo, tip.tree, path)
      .then(async (result) => {
        if (!alive) return;
        if ("file" in result) {
          const body = await fetchFile(repo, ref, path);
          if (alive) setFile(body.ok ? body.text : `⚠ ${body.text}`);
        } else {
          setEntries(result.entries);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repo, ref, path, tip]);

  const crumbs = path.split("/").filter(Boolean);
  const sorted = [...entries].sort((left, right) =>
    isDirectory(left) === isDirectory(right)
      ? left.name.localeCompare(right.name)
      : isDirectory(left)
        ? -1
        : 1,
  );

  return (
    <div className="flex min-h-0 flex-1">
      {/* the repos rail */}
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
              onClick={() => showCode(name)}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[13px]",
                name === repo
                  ? "bg-accent font-medium"
                  : "text-muted-foreground hover:bg-accent/60",
              )}
            >
              <FolderGit2 className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">{name}</span>
              {entry.status !== "ready" && (
                <span className="text-[9px] text-muted-foreground">
                  {entry.status}
                </span>
              )}
            </button>
          );
        })}
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* branch + breadcrumb */}
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
          <GitBranch className="size-3.5 text-muted-foreground" />
          <select
            aria-label="branch"
            value={ref}
            onChange={(event) => showCode(repo, event.target.value)}
            className="rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-xs"
          >
            {(branches.length > 0 ? branches : [ref]).map((branch) => (
              <option key={branch} value={branch}>
                {branch}
              </option>
            ))}
          </select>
          <nav aria-label="path" className="flex min-w-0 items-center gap-1 font-mono text-xs">
            <button
              type="button"
              onClick={() => showCode(repo, ref)}
              className="cursor-pointer text-muted-foreground hover:text-foreground"
            >
              org/{repo}
            </button>
            {crumbs.map((segment, index) => (
              <span key={index} className="flex items-center gap-1">
                <ChevronRight className="size-3 text-muted-foreground/60" />
                <button
                  type="button"
                  onClick={() =>
                    showCode(repo, ref, crumbs.slice(0, index + 1).join("/"))
                  }
                  className="cursor-pointer hover:text-foreground"
                >
                  {segment}
                </button>
              </span>
            ))}
          </nav>
          {tip !== undefined && (
            <span className="ml-auto flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
              <GitCommitHorizontal className="size-3" />
              {short(tip.oid)}
            </span>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {file !== undefined ? (
            /* one file, plainly — the document is the view */
            <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed">
              {file.length > 200_000 ? `${file.slice(0, 200_000)}\n… (truncated)` : file}
            </pre>
          ) : (
            <div className="mx-auto flex w-full max-w-3xl flex-col p-4">
              <div className="divide-y divide-border/40 rounded-md border border-border/60">
                {sorted.map((entry) => (
                  <button
                    key={entry.name}
                    type="button"
                    onClick={() =>
                      showCode(
                        repo,
                        ref,
                        [...crumbs, entry.name].join("/"),
                      )
                    }
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-accent/40"
                  >
                    {isDirectory(entry) ? (
                      <Folder className="size-3.5 shrink-0 text-mist" />
                    ) : (
                      <File className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {entry.name}
                    </span>
                  </button>
                ))}
                {sorted.length === 0 && (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                    empty tree
                  </div>
                )}
              </div>

              {/* recent history under the root listing */}
              {crumbs.length === 0 && log.length > 0 && (
                <div className="mt-6">
                  <div className="pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    recent commits
                  </div>
                  <div className="divide-y divide-border/40 rounded-md border border-border/60">
                    {log.map((commit) => (
                      <div
                        key={commit.oid}
                        className="flex items-center gap-2 px-3 py-1.5 text-xs"
                      >
                        <GitCommitHorizontal className="size-3 shrink-0 text-muted-foreground" />
                        <span className="font-mono text-muted-foreground">
                          {short(commit.oid)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {(commit.message ?? "").split("\n")[0] || "—"}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {commit.author?.name}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
