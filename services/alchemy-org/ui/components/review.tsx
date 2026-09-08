/**
 * The REVIEW — a pull request's diff beside the thread's conversation.
 * Review is CHAT: no comment lives in the diff; you select lines,
 * they become an ANCHOR PILL in the composer, and the message carries
 * them as `[label](anchor://…)` links the agent (and everyone after)
 * can resolve. Clicking a pill in the transcript focuses those lines
 * here.
 */

import { AnchorActionContext, ChatView } from "@/components/chat";
import { FileDiffCard } from "@/components/code";
import { Rail } from "@/components/rail";
import { Spinner } from "@/components/ui/spinner";
import type { Anchor } from "@/lib/channel";
import { anchorLabel, formatAnchor, parseAnchor } from "@/lib/channel";
import {
  fetchChangedFiles,
  LARGE_FILE_LINES,
  toGitDiff,
  type ChangedFile,
} from "@/lib/diff";
import { cn } from "@/lib/utils";
import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";
import {
  ChevronDown,
  FileCode2,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  RefreshCw,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
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
  forceNear,
}: {
  placeholder: ReactNode;
  children: ReactNode;
  /** Mount immediately (a focused anchor needs the lines rendered). */
  forceNear?: boolean;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (forceNear) setNear(true);
  }, [forceNear]);
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

const FileCard = ({
  renderable,
  focus,
  onSelect,
}: {
  renderable: RenderableFile;
  /** Lines to highlight (a clicked pill). */
  focus: { start: number; end: number } | undefined;
  onSelect: (path: string, range: SelectedLineRange | null) => void;
}) => {
  const { file, meta, raw } = renderable;
  const [collapsed, setCollapsed] = useState(false);
  const [wanted, setWanted] = useState(
    file.additions + file.deletions <= LARGE_FILE_LINES,
  );
  const path = file.filename;

  const options = useMemo(
    () => ({
      enableLineSelection: true,
      onLineSelected: (range: SelectedLineRange | null) =>
        onSelect(path, range),
    }),
    [path, onSelect],
  );

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
          <span className="text-brick">
            −{file.deletions.toLocaleString()}
          </span>
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
            forceNear={focus !== undefined}
            placeholder={
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Spinner className="size-4" />
              </div>
            }
          >
            <FileDiffCard
              file={meta}
              fallback={raw ?? ""}
              bare
              options={options}
              selectedLines={
                focus === undefined
                  ? undefined
                  : { start: focus.start, end: focus.end }
              }
            />
          </NearViewport>
        ))}
    </div>
  );
};

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
  threadId,
  active,
}: {
  owner: string;
  repo: string;
  number: number;
  threadId: string;
  active: boolean;
}) => {
  const [header, setHeader] = useState<PullHeader | undefined>(undefined);
  const [files, setFiles] = useState<RenderableFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [generation, setGeneration] = useState(0);

  // the pills being composed (selected but not yet sent)
  const [pills, setPills] = useState<Anchor[]>([]);
  // the focused anchor (a clicked pill in the transcript)
  const [focus, setFocus] = useState<Anchor | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setFiles([]);
    fetch(`/api/pulls/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`, {
      signal: controller.signal,
    })
      .then(async (response) =>
        response.ok ? ((await response.json()) as PullHeader) : undefined,
      )
      .then((view) => setHeader(view))
      .catch(() => {});
    fetchChangedFiles(
      owner,
      repo,
      number,
      (page) =>
        setFiles((current) => [
          ...current,
          ...page.files.map(toRenderable),
        ]),
      controller.signal,
    )
      .then(() => setLoading(false))
      .catch((thrown: unknown) => {
        if (!controller.signal.aborted) {
          setError(thrown instanceof Error ? thrown.message : String(thrown));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [owner, repo, number, generation]);

  /** A completed selection becomes a pill (replacing a same-file one
   *  still pending — drags re-fire). */
  const onSelect = useCallback(
    (path: string, range: SelectedLineRange | null) => {
      if (range === null) return;
      const anchor: Anchor = {
        owner,
        repo,
        number,
        path,
        start: Math.min(range.start, range.end),
        end: Math.max(range.start, range.end),
        ...(headerRef.current?.head.sha === undefined
          ? {}
          : { sha: headerRef.current.head.sha }),
      };
      setPills((current) => [
        ...current.filter((pill) => pill.path !== path),
        anchor,
      ]);
    },
    [owner, repo, number],
  );
  const headerRef = useRef<PullHeader | undefined>(undefined);
  headerRef.current = header;

  /** A pill in the transcript clicked: scroll its file here, light
   *  its lines. */
  const onAnchorAction = useCallback(
    (href: string) => {
      const anchor = parseAnchor(href);
      if (anchor === undefined) return;
      setFocus(anchor);
      // scroll once the card exists (forceNear mounts it)
      requestAnimationFrame(() => {
        scrollRef.current
          ?.querySelector(`[data-review-file="${CSS.escape(anchor.path)}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    },
    [],
  );

  /** Serialize the pills into the outgoing message. */
  const transformSubmit = useCallback(
    (text: string): string => {
      if (pills.length === 0) return text;
      const links = pills
        .map((pill) => `[${anchorLabel(pill)}](${formatAnchor(pill)})`)
        .join(" ");
      setPills([]);
      return `${text}\n\n${links}`;
    },
    [pills],
  );

  const badge = header === undefined ? undefined : STATE_BADGE[header.state];

  return (
    <AnchorActionContext.Provider value={onAnchorAction}>
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* the diff column */}
        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
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
                <span className="ml-auto">
                  Select lines in the diff to pin them to your next message.
                </span>
              </div>
            )}
            {error !== undefined && (
              <div className="rounded-md border border-brick/40 bg-brick/10 px-3 py-2 text-xs text-brick">
                diff failed: {error}
              </div>
            )}
            {files.map((renderable) => (
              <FileCard
                key={renderable.file.filename}
                renderable={renderable}
                focus={
                  focus?.path === renderable.file.filename
                    ? { start: focus.start, end: focus.end }
                    : undefined
                }
                onSelect={onSelect}
              />
            ))}
            {loading && (
              <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
                <Spinner className="size-4" />
                <span className="text-xs">Loading the diff…</span>
              </div>
            )}
          </div>
        </div>

        {/* the conversation — the SAME thread chat, with the pill row */}
        <Rail
          label="Review chat"
          storageKey="review-chat-width"
          defaultWidth={480}
          minWidth={360}
        >
          <ChatView
            id={`Thread:${threadId}`}
            active={active}
            placeholder="Chat with the review…"
            transformSubmit={transformSubmit}
            composerExtra={
              pills.length > 0 ? (
                <div className="flex flex-wrap gap-1 px-3 pt-2">
                  {pills.map((pill) => (
                    <span
                      key={formatAnchor(pill)}
                      className="flex items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]"
                    >
                      <FileCode2 className="size-3 text-mist" />
                      {anchorLabel(pill)}
                      <button
                        type="button"
                        onClick={() =>
                          setPills((current) =>
                            current.filter((entry) => entry !== pill),
                          )
                        }
                        aria-label={`remove ${anchorLabel(pill)}`}
                        className="cursor-pointer rounded p-0.5 hover:bg-accent"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : undefined
            }
          />
        </Rail>
      </div>
    </AnchorActionContext.Provider>
  );
};
