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
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

const short = (oid: string): string => oid.slice(0, 7);

/** VS Code-size expand chevrons — the built-ins render at full icon
 *  size (svg width/height attributes); CSS in the shadow root wins
 *  over presentation attributes. Injected post-mount because the
 *  component reads its unsafe-css attribute only at construction,
 *  before React has set it. */
const TREE_CSS = `
  [data-icon-name="file-tree-icon-chevron"] {
    width: 11px;
    height: 11px;
    opacity: 0.75;
  }
`;

const useVsCodeChevrons = (host: React.RefObject<HTMLDivElement | null>) => {
  useEffect(() => {
    const inject = () => {
      const tree = host.current?.querySelector("file-tree-container");
      const root = tree?.shadowRoot;
      if (!root || root.querySelector("#vscode-chevrons")) return root != null;
      const style = document.createElement("style");
      style.id = "vscode-chevrons";
      style.textContent = TREE_CSS;
      root.append(style);
      return true;
    };
    if (inject()) return;
    // the custom element upgrades a beat after first paint
    const timer = setInterval(() => {
      if (inject()) clearInterval(timer);
    }, 120);
    return () => clearInterval(timer);
  });
};

export const CodeBrowser = ({ place }: { place: CodePlace }) => {
  const { repo, ref, path } = place;
  const [repos, setRepos] = useState<ReadonlyArray<SeedStatus>>([]);
  const [branches, setBranches] = useState<ReadonlyArray<string>>([]);
  const [trees, setTrees] = useState<Record<string, FullTree>>({});
  const [file, setFile] = useState<string | undefined>();
  const [log, setLog] = useState<ReadonlyArray<CommitInfo>>([]);

  useEffect(() => {
    fetchRepos()
      .then(setRepos)
      .catch(() => {});
  }, []);

  // ONE tree for the whole org: every ready repository is a top-level
  // folder (a multi-root workspace), its files nested beneath it
  useEffect(() => {
    let alive = true;
    for (const entry of repos) {
      if (entry.status !== "ready") continue;
      const name = entry.repo.split("/")[1] ?? entry.repo;
      const wanted = name === repo ? ref : "main";
      fetchFullTree(name, wanted)
        .then((tree) => {
          if (!alive) return;
          setTrees((current) =>
            current[name]?.commit === tree.commit &&
            current[name]?.ref === tree.ref
              ? current
              : { ...current, [name]: tree },
          );
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [repos, repo, ref]);

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
        if (alive) setLog(items);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repo, ref]);

  const full = trees[repo];
  const paths = useMemo(
    () =>
      Object.entries(trees).flatMap(([name, tree]) =>
        tree.files.map((entry) => `${name}/${entry.path}`),
      ),
    [trees],
  );
  const isFile = useMemo(
    () => new Set(full?.files.map((entry) => entry.path) ?? []),
    [full],
  ).has(path);

  const { model } = useFileTree({
    initialExpansion: "closed",
    paths: [],
    onSelectionChange: (selected: ReadonlyArray<string>) => {
      const chosen = selected[0];
      if (chosen === undefined) return;
      const [root, ...rest] = chosen.split("/");
      if (root === undefined || rest.length === 0) return;
      showCode(root, root === repo ? ref : "main", rest.join("/"));
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
  const treeHost = useRef<HTMLDivElement | null>(null);
  useVsCodeChevrons(treeHost);

  return (
    <div className="flex min-h-0 flex-1">
      {/* repos + the whole tree, one request */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="flex shrink-0 items-center gap-2 px-3 pt-2 pb-1">
          <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            org
          </span>
          {repos.some((entry) => entry.status !== "ready") && (
            <span className="text-[9px] text-muted-foreground">
              (some repositories still importing)
            </span>
          )}
        </div>
        <div ref={treeHost} className="min-h-0 flex-1 overflow-y-auto">
          {paths.length === 0 ? (
            <div className="px-3 py-4 text-[12px] text-muted-foreground">
              loading the trees…
            </div>
          ) : (
            <FileTree
              model={model}
              style={
                {
                  height: "100%",
                  // VS Code posture: flat square rows, tight leading
                  "--trees-border-radius-override": "0px",
                  "--trees-row-height": "24px",
                  ...treeStyles,
                } as React.CSSProperties
              }
            />
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
            <FileCard
              flush
              path={path}
              contents={
                file.length > 200_000
                  ? `${file.slice(0, 200_000)}\n… (truncated)`
                  : file
              }
            />
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
