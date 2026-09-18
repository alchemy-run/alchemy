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
import { ChevronRight, GitBranch, GitCommitHorizontal, X } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

const short = (oid: string): string => oid.slice(0, 7);

/**
 * EDITOR TABS, the VS Code contract: a single click opens a file as
 * the PREVIEW tab (italic, at most one — the next preview replaces it
 * in place); a double click, on the tree row or the tab itself, PINS
 * it. X closes one; the context menu closes all, or everything to one
 * side; tabs drag to reorder. The set persists across reloads.
 */
interface EditorTab {
  readonly repo: string;
  readonly ref: string;
  readonly path: string;
  readonly pinned: boolean;
}

const TAB_KEY = (tab: { repo: string; path: string }) =>
  `${tab.repo}:${tab.path}`;
const TABS_STORE = "root:code-tabs";

const loadTabs = (): EditorTab[] => {
  try {
    const raw = localStorage.getItem(TABS_STORE);
    return raw === null ? [] : (JSON.parse(raw) as EditorTab[]);
  } catch {
    return [];
  }
};

/** VS Code-size expand chevrons — the built-ins render at full icon
 *  size (svg width/height attributes); CSS in the shadow root wins
 *  over presentation attributes. Injected post-mount because the
 *  component reads its unsafe-css attribute only at construction,
 *  before React has set it. */
const REPO_ICON = encodeURIComponent(
  // Octicons repo-16 — the forge's repository mark
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/></svg>`,
);

const TREE_CSS = `
  [data-icon-name="file-tree-icon-chevron"] {
    width: 11px;
    height: 11px;
    opacity: 0.75;
  }
  /* repo roots: VS Code's semibold workspace folder, with the forge's
     repo mark drawn before the name (the icon slot holds the chevron,
     so the mark rides the name's flex container) */
  [data-item-type="folder"][aria-level="1"] {
    font-weight: var(--trees-font-weight-semibold);
  }
  [data-item-type="folder"][aria-level="1"] [data-truncate-group-container]::before {
    content: "";
    align-self: center;
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    margin-right: 6px;
    background-color: var(--trees-fg-muted);
    -webkit-mask: url("data:image/svg+xml,${REPO_ICON}") center / contain no-repeat;
    mask: url("data:image/svg+xml,${REPO_ICON}") center / contain no-repeat;
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
  const [tabs, setTabs] = useState<EditorTab[]>(loadTabs);
  const [dragging, setDragging] = useState<string | undefined>();
  const [menu, setMenu] = useState<
    { key: string; x: number; y: number } | undefined
  >();

  useEffect(() => {
    localStorage.setItem(TABS_STORE, JSON.stringify(tabs));
  }, [tabs]);

  /** A file arrived (tree click or deep link): preview it. */
  const openPreview = (next: Omit<EditorTab, "pinned">) =>
    setTabs((current) => {
      if (current.some((tab) => TAB_KEY(tab) === TAB_KEY(next))) return current;
      const preview = current.findIndex((tab) => !tab.pinned);
      const opened = { ...next, pinned: false };
      if (preview === -1) return [...current, opened];
      return current.map((tab, index) => (index === preview ? opened : tab));
    });

  const pin = (key: string) =>
    setTabs((current) =>
      current.map((tab) =>
        TAB_KEY(tab) === key ? { ...tab, pinned: true } : tab,
      ),
    );

  const closeTabs = (keys: ReadonlySet<string>) => {
    setMenu(undefined);
    setTabs((current) => {
      const kept = current.filter((tab) => !keys.has(TAB_KEY(tab)));
      // closing the ACTIVE tab moves focus to its neighbor
      const activeKey = TAB_KEY({ repo, path });
      if (keys.has(activeKey)) {
        const index = current.findIndex((tab) => TAB_KEY(tab) === activeKey);
        const next = kept[Math.min(index, kept.length - 1)];
        if (next !== undefined) showCode(next.repo, next.ref, next.path);
        else showCode(repo, ref);
      }
      return kept;
    });
  };

  const moveTab = (from: string, to: string) =>
    setTabs((current) => {
      const a = current.findIndex((tab) => TAB_KEY(tab) === from);
      const b = current.findIndex((tab) => TAB_KEY(tab) === to);
      if (a === -1 || b === -1 || a === b) return current;
      const next = [...current];
      const [moved] = next.splice(a, 1);
      next.splice(b, 0, moved!);
      return next;
    });

  // the open file always has a tab — deep links included
  useEffect(() => {
    if (path.length > 0) openPreview({ repo, ref, path });
  }, [repo, ref, path]);

  // pin on tree double-click: dblclick is composed, so it crosses the
  // shadow boundary and carries the row in its path
  useEffect(() => {
    const host = treeHost.current;
    if (host === null) return;
    const onDouble = (event: MouseEvent) => {
      for (const node of event.composedPath()) {
        const el = node as HTMLElement;
        if (el?.getAttribute?.("data-item-type") === "file") {
          const itemPath = el.getAttribute("data-item-path");
          if (itemPath !== null) {
            const [root, ...rest] = itemPath.split("/");
            if (root !== undefined && rest.length > 0) {
              const tabRepo = root;
              const tabPath = rest.join("/");
              setTabs((current) =>
                current.some(
                  (tab) =>
                    TAB_KEY(tab) === TAB_KEY({ repo: tabRepo, path: tabPath }),
                )
                  ? current.map((tab) =>
                      TAB_KEY(tab) === TAB_KEY({ repo: tabRepo, path: tabPath })
                        ? { ...tab, pinned: true }
                        : tab,
                    )
                  : [
                      ...current,
                      {
                        repo: tabRepo,
                        ref: tabRepo === repo ? ref : "main",
                        path: tabPath,
                        pinned: true,
                      },
                    ],
              );
            }
          }
          return;
        }
      }
    };
    host.addEventListener("dblclick", onDouble);
    return () => host.removeEventListener("dblclick", onDouble);
  }, [repo, ref]);

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
      // folders select too (their paths end in "/") — only files open
      if (chosen === undefined || chosen.endsWith("/")) return;
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
        {repos.some((entry) => entry.status !== "ready") && (
          <div className="shrink-0 px-3 pt-2 pb-1 text-[10px] text-muted-foreground">
            some repositories are still importing…
          </div>
        )}
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
                  // VS Code posture: flat square rows whose hover and
                  // selection bands run flush to the sidebar's edges
                  "--trees-border-radius-override": "0px",
                  "--trees-padding-inline-override": "0px",
                  "--trees-item-margin-x-override": "0px",
                  ...treeStyles,
                } as React.CSSProperties
              }
            />
          )}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {tabs.length > 0 && (
          <div className="flex shrink-0 items-stretch overflow-x-auto border-b border-border bg-muted/20">
            {tabs.map((tab) => {
              const key = TAB_KEY(tab);
              const active = tab.repo === repo && tab.path === path;
              const name = tab.path.split("/").pop() ?? tab.path;
              return (
                <div
                  key={key}
                  draggable
                  onDragStart={() => setDragging(key)}
                  onDragEnd={() => setDragging(undefined)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    if (dragging !== undefined && dragging !== key) {
                      moveTab(dragging, key);
                    }
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ key, x: event.clientX, y: event.clientY });
                  }}
                  className={cn(
                    "group/tab flex max-w-52 shrink-0 cursor-pointer items-center gap-1.5 border-r border-border/60 px-3 text-[12px]",
                    active
                      ? "bg-background text-foreground shadow-[inset_0_1px_0_var(--color-primary)]"
                      : "text-muted-foreground hover:bg-accent/40",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => showCode(tab.repo, tab.ref, tab.path)}
                    onDoubleClick={() => pin(key)}
                    className={cn(
                      "min-w-0 cursor-pointer truncate py-1.5",
                      !tab.pinned && "italic",
                    )}
                    title={`${tab.repo}/${tab.path}`}
                  >
                    {name}
                  </button>
                  <button
                    type="button"
                    aria-label={`close ${name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTabs(new Set([key]));
                    }}
                    className={cn(
                      "shrink-0 cursor-pointer rounded p-0.5 hover:bg-accent",
                      active
                        ? "opacity-70"
                        : "opacity-0 group-hover/tab:opacity-70",
                    )}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              );
            })}
            <div className="min-w-4 flex-1" />
            <button
              type="button"
              title="close all tabs"
              onClick={() => closeTabs(new Set(tabs.map(TAB_KEY)))}
              className="shrink-0 cursor-pointer px-2 text-muted-foreground opacity-60 hover:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
        {menu !== undefined && (
          <>
            <button
              type="button"
              aria-label="dismiss"
              className="fixed inset-0 z-40 cursor-default"
              onClick={() => setMenu(undefined)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu(undefined);
              }}
            />
            <div
              className="fixed z-50 min-w-44 rounded-md border border-border bg-popover py-1 text-[12px] shadow-md"
              style={{ left: menu.x, top: menu.y }}
            >
              {(() => {
                const index = tabs.findIndex(
                  (tab) => TAB_KEY(tab) === menu.key,
                );
                const item = (
                  label: string,
                  keys: ReadonlyArray<string>,
                  disabled = keys.length === 0,
                ) => (
                  <button
                    key={label}
                    type="button"
                    disabled={disabled}
                    onClick={() => closeTabs(new Set(keys))}
                    className={cn(
                      "block w-full cursor-pointer px-3 py-1 text-left",
                      disabled
                        ? "cursor-default text-muted-foreground/50"
                        : "hover:bg-accent",
                    )}
                  >
                    {label}
                  </button>
                );
                return [
                  item("Close", [menu.key]),
                  item("Close to the Left", tabs.slice(0, index).map(TAB_KEY)),
                  item(
                    "Close to the Right",
                    tabs.slice(index + 1).map(TAB_KEY),
                  ),
                  item("Close All", tabs.map(TAB_KEY)),
                ];
              })()}
            </div>
          </>
        )}
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
