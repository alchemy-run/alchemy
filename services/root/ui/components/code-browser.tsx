/**
 * CODE — the forge's repositories, browsed (`/code/:repo/:ref/*path`).
 *
 * Left: the org's repos and the WHOLE file tree — one request
 * (`/api/forge/repos/:owner/:repo/tree`), rendered with Pierre's tree
 * (@pierre/trees), no folder paging. Right: the file, or the recent
 * history while nothing is open. Everything reads the embedded git
 * server.
 */
import { FileCard } from "@/components/code";
import {
  fetchBranches,
  fetchFile,
  fetchFullTree,
  fetchLog,
  fetchRepos,
  type CommitInfo,
  type FullTree,
  type SeedStatus,
} from "@/lib/forge";
import { showCode, type CodePlace } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { useTreeStyles } from "@/lib/tree-theme";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  ChevronRight,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const short = (oid: string): string => oid.slice(0, 7);

export const CodeBrowser = ({ place }: { place: CodePlace }) => {
  const { repo, ref, path } = place;
  const [repos, setRepos] = useState<ReadonlyArray<SeedStatus>>([]);
  const [branches, setBranches] = useState<ReadonlyArray<string>>([]);
  const [full, setFull] = useState<FullTree | undefined>();
  const [file, setFile] = useState<string | undefined>();
  const [log, setLog] = useState<ReadonlyArray<CommitInfo>>([]);

  useEffect(() => {
    fetchRepos()
      .then(setRepos)
      .catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    setFull(undefined);
    fetchBranches(repo)
      .then((body) =>
        setBranches(
          body.refs.map((entry) => entry.name.replace("refs/heads/", "")),
        ),
      )
      .catch(() => {});
    fetchLog(repo, ref, 20)
      .then((items) => {
        if (alive) setLog(items);
      })
      .catch(() => {});
    fetchFullTree(repo, ref)
      .then((tree) => {
        if (alive) setFull(tree);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repo, ref]);

  const paths = useMemo(
    () => (full?.files ?? []).map((entry) => entry.path),
    [full],
  );
  const isFile = useMemo(() => new Set(paths), [paths]).has(path);

  const { model } = useFileTree({
    initialExpansion: "closed",
    paths: [],
    onSelectionChange: (selected: ReadonlyArray<string>) => {
      const chosen = selected[0];
      if (chosen !== undefined) showCode(repo, ref, chosen);
    },
  });
  useEffect(() => {
    model.resetPaths([...paths]);
  }, [model, paths]);

  useEffect(() => {
    let alive = true;
    setFile(undefined);
    if (!isFile) return;
    fetchFile(repo, ref, path)
      .then((body) => {
        if (alive) setFile(body.ok ? body.text : `⚠ ${body.text}`);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repo, ref, path, isFile]);

  const crumbs = path.split("/").filter(Boolean);
  const tip = log[0];
  const treeStyles = useTreeStyles();

  return (
    <div className="flex min-h-0 flex-1">
      {/* repos + the whole tree, one request */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="shrink-0 p-2">
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
                  "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[13px]",
                  name === repo
                    ? "bg-accent font-medium"
                    : "text-muted-foreground hover:bg-accent/60",
                )}
              >
                <FolderGit2 className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-left">
                  {name}
                </span>
                {entry.status !== "ready" && (
                  <span className="text-[9px] text-muted-foreground">
                    {entry.status}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border/60 px-1 py-2">
          {full === undefined ? (
            <div className="px-3 py-4 text-[12px] text-muted-foreground">
              loading the tree…
            </div>
          ) : (
            <FileTree model={model} style={{ height: "100%", ...treeStyles }} />
          )}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
          <nav
            aria-label="path"
            className="flex min-w-0 items-center gap-1 font-mono text-xs"
          >
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
                <span
                  className={cn(
                    index === crumbs.length - 1 && "text-foreground",
                  )}
                >
                  {segment}
                </span>
              </span>
            ))}
          </nav>
          {full !== undefined && (
            <span className="ml-auto flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
              <span>{full.files.length.toLocaleString()} files</span>
              <GitCommitHorizontal className="size-3" />
              {short(full.commit)}
            </span>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {file !== undefined ? (
            <div className="p-4">
              <FileCard
                path={path}
                contents={
                  file.length > 200_000
                    ? `${file.slice(0, 200_000)}\n… (truncated)`
                    : file
                }
              />
            </div>
          ) : (
            <div className="mx-auto flex w-full max-w-3xl flex-col p-4">
              <div className="rounded-md border border-border/60 px-4 py-8 text-center text-sm text-muted-foreground">
                pick a file in the tree
              </div>
              {log.length > 0 && (
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
