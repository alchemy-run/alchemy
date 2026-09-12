/**
 * The REVIEW — a pull request's diff: the header (state, branches,
 * size), one collapsible card per changed file, paged in from GitHub
 * with large files gated behind a click, and a refresh. The page is
 * the diff alone — a review conversation is a later concern.
 */

import { FileDiffCard } from "@/components/code";
import { Spinner } from "@/components/ui/spinner";
import {
  fetchChangedFiles,
  LARGE_FILE_LINES,
  toGitDiff,
  type ChangedFile,
} from "@/lib/diff";
import { cn } from "@/lib/utils";
import type { FileDiffMetadata } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";
import {
  ChevronDown,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  RefreshCw,
} from "lucide-react";
import {
  memo,
  startTransition,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/* ── data ─────────────────────────────────────────────────────────── */

interface PullHeader {
  readonly title: string;
  readonly state: "open" | "closed" | "merged" | "draft";
  readonly head: { readonly ref: string; readonly sha: string };
  readonly base: { readonly ref: string };
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
}

interface RenderableFile {
  file: ChangedFile;
  /** Parsed for the renderer; `undefined` when GitHub sent no hunks
   *  (binary, or this file alone too large). */
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

/* ── file cards ───────────────────────────────────────────────────── */

/** Render `children` only once the box has scrolled near the viewport
 *  (and keep it thereafter) — a 300-file PR must not mount 300 diff
 *  renderers on open. */
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

const FileCard = memo(({ renderable }: { renderable: RenderableFile }) => {
  const { file, meta, raw } = renderable;
  const [collapsed, setCollapsed] = useState(false);
  const [wanted, setWanted] = useState(
    file.additions + file.deletions <= LARGE_FILE_LINES,
  );
  const path = file.filename;

  return (
    <div
      data-review-file={path}
      className="overflow-hidden rounded-md border border-border"
    >
      <button
        type="button"
        onClick={() => setCollapsed((current) => !current)}
        className="flex w-full cursor-pointer items-center gap-2 border-b border-border/60 bg-sidebar px-3 py-1.5 text-left"
      >
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {path}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          <span className="text-moss">+{file.additions.toLocaleString()}</span>{" "}
          <span className="text-brick">−{file.deletions.toLocaleString()}</span>
        </span>
      </button>
      {!collapsed &&
        (meta === undefined ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {file.status === "removed"
              ? "File deleted."
              : "No diff to render (binary or too large)."}
          </div>
        ) : !wanted ? (
          <button
            type="button"
            onClick={() => setWanted(true)}
            className="w-full cursor-pointer px-3 py-3 text-center text-xs text-muted-foreground hover:bg-accent/40"
          >
            Large diff ({(file.additions + file.deletions).toLocaleString()}{" "}
            lines) — click to render.
          </button>
        ) : (
          <NearViewport
            placeholder={
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Spinner className="size-4" />
              </div>
            }
          >
            <FileDiffCard file={meta} fallback={raw ?? ""} bare />
          </NearViewport>
        ))}
    </div>
  );
});
FileCard.displayName = "FileCard";

/* ── the view ─────────────────────────────────────────────────────── */

const STATE_BADGE: Record<
  PullHeader["state"],
  { label: string; className: string; icon: typeof GitPullRequestArrow }
> = {
  open: {
    label: "Open",
    className: "border-moss/40 bg-moss/10 text-moss",
    icon: GitPullRequestArrow,
  },
  draft: {
    label: "Draft",
    className: "border-border bg-muted text-muted-foreground",
    icon: GitPullRequestArrow,
  },
  merged: {
    label: "Merged",
    className: "border-terracotta/40 bg-terracotta/10 text-terracotta",
    icon: GitMerge,
  },
  closed: {
    label: "Closed",
    className: "border-brick/40 bg-brick/10 text-brick",
    icon: GitPullRequestClosed,
  },
};

export const ReviewView = ({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) => {
  const [header, setHeader] = useState<PullHeader | undefined>(undefined);
  const [files, setFiles] = useState<RenderableFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [generation, setGeneration] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // ONE commit per load: the header and every file page are buffered
  // and land together — content filling in card by card re-lays the
  // page out step by step, and each partial commit re-renders what is
  // already showing. A refresh keeps the old diff up until the new one
  // is whole; the transition keeps the heavy first render of a big
  // diff interruptible, so tab clicks stay responsive under it.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    const header = fetch(
      `/api/pulls/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`,
      { signal: controller.signal },
    )
      .then(async (response) =>
        response.ok ? ((await response.json()) as PullHeader) : undefined,
      )
      .catch(() => undefined);
    const collected: RenderableFile[] = [];
    const pages = fetchChangedFiles(
      owner,
      repo,
      number,
      (page) => collected.push(...page.files.map(toRenderable)),
      controller.signal,
    );
    void Promise.all([header, pages]).then(
      ([view]) => {
        if (controller.signal.aborted) return;
        startTransition(() => {
          if (view !== undefined) setHeader(view);
          setFiles(collected);
          setLoading(false);
        });
      },
      (thrown: unknown) => {
        if (controller.signal.aborted) return;
        setError(thrown instanceof Error ? thrown.message : String(thrown));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [owner, repo, number, generation]);

  // WHEEL ROUTING — the pane scrolls vertically, each file's code
  // area horizontally (`overflow-x` only, in the renderer's shadow
  // DOM). Chromium latches a whole gesture — momentum included — to
  // whichever scroller consumed its first event, so a flick that
  // starts with a horizontal component swallows every vertical delta
  // until the momentum dies (and vice versa): the pane feels stuck on
  // one axis. Route each gesture by its dominant axis instead —
  // vertical deltas move the pane, horizontal deltas move the code
  // scroller under the cursor.
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    let axis: "x" | "y" = "y";
    let last = 0;
    const scroller = (
      event: WheelEvent,
      can: (element: HTMLElement) => boolean,
    ): HTMLElement | undefined => {
      // composedPath reaches through the renderer's open shadow roots
      for (const target of event.composedPath()) {
        if (target === node) return undefined;
        if (target instanceof HTMLElement && can(target)) return target;
      }
      return undefined;
    };
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return; // pinch-zoom
      const scale =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? node.clientHeight
            : 1;
      const dx = event.deltaX * scale;
      const dy = event.deltaY * scale;
      // a pause ends the gesture — the next event picks the axis anew
      if (event.timeStamp - last > 150) {
        axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      }
      last = event.timeStamp;
      if (axis === "y") {
        // a nested vertical scroller (none today) keeps native wheel
        const nested = scroller(
          event,
          (element) =>
            element.scrollHeight > element.clientHeight &&
            /^(auto|scroll)$/.test(getComputedStyle(element).overflowY),
        );
        if (nested !== undefined) return;
        node.scrollTop += dy;
        event.preventDefault();
        return;
      }
      const sideways = scroller(
        event,
        (element) =>
          element.scrollWidth > element.clientWidth &&
          /^(auto|scroll)$/.test(getComputedStyle(element).overflowX),
      );
      if (sideways !== undefined) {
        sideways.scrollLeft += dx;
        event.preventDefault();
      }
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  const badge = header === undefined ? undefined : STATE_BADGE[header.state];

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div
        ref={scrollRef}
        data-review-scroll=""
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        <div className="flex flex-col gap-3 px-4 py-4">
          <div className="flex items-center gap-2">
            {badge !== undefined && (
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                  badge.className,
                )}
              >
                <badge.icon className="size-3" />
                {badge.label}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">
              {header?.title ?? `${owner}/${repo}#${number}`}
            </span>
            <a
              href={`https://github.com/${owner}/${repo}/pull/${number}`}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              #{number}
            </a>
            <button
              type="button"
              onClick={() => setGeneration((current) => current + 1)}
              title="Refresh the diff from GitHub"
              className="shrink-0 cursor-pointer rounded border border-border p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </div>
          {header !== undefined && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="font-mono">
                {header.head.ref} → {header.base.ref}
              </span>
              <span className="font-mono tabular-nums">
                <span className="text-moss">+{header.additions}</span>{" "}
                <span className="text-brick">−{header.deletions}</span>
              </span>
              <span>{header.changedFiles} files</span>
            </div>
          )}
          {error !== undefined && (
            <div className="rounded-md border border-brick/40 bg-brick/10 px-3 py-2 text-xs text-brick">
              diff failed: {error}
            </div>
          )}
          {files.map((renderable) => (
            <FileCard key={renderable.file.filename} renderable={renderable} />
          ))}
          {loading && (
            <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
              <Spinner className="size-4" />
              <span className="text-xs">Loading the diff…</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
