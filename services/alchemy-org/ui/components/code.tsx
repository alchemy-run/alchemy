import {
  DARK_CODE_THEME,
  ensureCodeTheme,
  LIGHT_CODE_THEME,
} from "@/lib/code-theme";
import { useResolvedTheme } from "@/lib/theme";
import type { DiffLineAnnotation, FileDiffMetadata } from "@pierre/diffs";
import {
  File,
  FileDiff,
  PatchDiff,
  type BaseCodeOptions,
} from "@pierre/diffs/react";
import { cn } from "@/lib/utils";
import { Check, Copy } from "lucide-react";
import {
  Component,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Code + diff rendering on @pierre/diffs — Shiki-highlighted, shadow
 * DOM–scoped, space-efficient. Three cards:
 *
 * - {@link CodeCard}: a highlighted code snippet (markdown fenced
 *   blocks, tool bodies). No header, no line numbers, wrapped — the
 *   chrome belongs to the surrounding card.
 * - {@link DiffCard}: a unified diff rendered from a patch string
 *   (ReadDiff tool output) — line numbers, word-level inline
 *   highlights, compact hunk separators.
 * - {@link FileDiffCard}: ONE parsed file of a PR's diff, with the
 *   review's inline comments drawn on their lines — the "Files
 *   changed" page.
 *
 * Every card follows the page's mode: the docs' walnut code surface in
 * dark, lifted parchment in light (`lib/code-theme.ts`). The renderer
 * lives in a shadow root where the page's tokens can't reach, so it is
 * told which theme is showing outright; the chrome around it
 * (`code-surface`, the `--code*` tokens) switches with the page.
 */

/** Markdown language tag → file extension (Shiki detects by name). */
const EXTENSION: Record<string, string> = {
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  javascript: "js",
  js: "js",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  bash: "sh",
  sh: "sh",
  shell: "sh",
  zsh: "sh",
  python: "py",
  py: "py",
  rust: "rs",
  go: "go",
  markdown: "md",
  md: "md",
  yaml: "yaml",
  yml: "yaml",
  html: "html",
  css: "css",
  sql: "sql",
  toml: "toml",
  diff: "diff",
  zig: "zig",
  c: "c",
  cpp: "cpp",
  java: "java",
  ruby: "rb",
  rb: "rb",
};

ensureCodeTheme();

/** The renderer's base options: both brand themes, and which one the
 *  page is showing — it lives in a shadow root, so it has to be told. */
const OPTIONS: Record<"light" | "dark", BaseCodeOptions> = {
  light: {
    theme: { light: LIGHT_CODE_THEME, dark: DARK_CODE_THEME },
    themeType: "light",
  },
  dark: {
    theme: { light: LIGHT_CODE_THEME, dark: DARK_CODE_THEME },
    themeType: "dark",
  },
};
const useBaseOptions = (): BaseCodeOptions => OPTIONS[useResolvedTheme()];

/** The frame every card shares: the code surface, its hairline. */
const CARD = "code-surface overflow-hidden rounded-md border text-[13px]";

/** Copy `text` to the clipboard — GitHub's snippet button: it shows
 *  on hover (always, once focused), and turns into a check for a
 *  moment after copying. */
export const CopyButton = ({
  text,
  className,
  label = "Copy code",
}: {
  text: string;
  className?: string;
  label?: string;
}) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = useCallback(() => {
    if (!navigator.clipboard?.writeText) return;
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1_500);
      },
      () => {},
    );
  }, [text]);
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      data-copied={copied || undefined}
      onClick={copy}
      className={cn(
        // on the walnut surface, whatever the page's mode
        "flex size-6 items-center justify-center rounded-md border border-code-border bg-code/90 text-code-muted shadow-xs backdrop-blur-sm hover:bg-code-border hover:text-code-foreground",
        copied && "text-code-addition hover:text-code-addition",
        className,
      )}
    >
      <Icon className="size-3.5" />
    </button>
  );
};

export const CodeCard = memo(
  ({ code, language }: { code: string; language: string | undefined }) => {
    const base = useBaseOptions();
    const contents = code.replace(/\n$/, "");
    const file = useMemo(
      () => ({
        name: `snippet.${EXTENSION[language ?? ""] ?? language ?? "txt"}`,
        contents,
      }),
      [contents, language],
    );
    const options = useMemo(
      () => ({
        ...base,
        disableFileHeader: true,
        disableLineNumbers: true,
        overflow: "wrap" as const,
      }),
      [base],
    );
    return (
      <CodeBoundary fallback={code}>
        <div className={cn(CARD, "group/code relative my-2")}>
          <File file={file} options={options} />
          <CopyButton
            text={contents}
            className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100 data-[copied]:opacity-100"
          />
        </div>
      </CodeBoundary>
    );
  },
);
CodeCard.displayName = "CodeCard";

/** A rendering error must never blank the thread — fall back to a
 *  plain <pre> of the raw text. */
class CodeBoundary extends Component<
  { fallback: string; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-2 font-mono text-[11px] leading-4">
        {this.props.fallback}
      </pre>
    ) : (
      this.props.children
    );
  }
}

/** A git-format patch can carry several files; `PatchDiff` renders
 *  exactly one — split on the `diff --git` boundaries. */
export const splitPatchFiles = (patch: string): string[] => {
  const starts = [...patch.matchAll(/^diff --git /gm)].map(
    (match) => match.index,
  );
  if (starts.length <= 1) return [patch];
  return starts.map((start, index) =>
    patch.slice(start, starts[index + 1] ?? patch.length),
  );
};

/** A unified diff from a patch string (git format), one file per card. */
export const DiffCard = memo(({ patch }: { patch: string }) => {
  const base = useBaseOptions();
  const files = useMemo(() => splitPatchFiles(patch), [patch]);
  const options = useMemo(
    () => ({
      ...base,
      diffStyle: "unified" as const,
      hunkSeparators: "metadata" as const,
      overflow: "scroll" as const,
    }),
    [base],
  );
  return (
    <CodeBoundary fallback={patch}>
      {files.map((file, index) => (
        <div key={index} className={cn(CARD, "my-1")}>
          <PatchDiff patch={file} options={options} />
        </div>
      ))}
    </CodeBoundary>
  );
});
DiffCard.displayName = "DiffCard";

/**
 * One file of a pull request's diff (already parsed — see
 * `parsePatchFiles`), unified, with the review's inline comments drawn
 * under the lines they were left on. The renderer's own file header
 * (name, change kind, +/−) is kept.
 */
export const FileDiffCard = <A,>({
  file,
  annotations,
  renderAnnotation,
  fallback,
  bare = false,
}: {
  file: FileDiffMetadata;
  annotations?: DiffLineAnnotation<A>[];
  renderAnnotation?: (annotation: DiffLineAnnotation<A>) => ReactNode;
  /** The raw text of this file's diff, shown if rendering throws. */
  fallback: string;
  /** Hunks only — no card chrome and no renderer file header — for a
   *  caller that draws its own header around the diff. */
  bare?: boolean;
}) => {
  const base = useBaseOptions();
  const options = useMemo(
    () => ({
      ...base,
      diffStyle: "unified" as const,
      hunkSeparators: "line-info" as const,
      overflow: "scroll" as const,
      disableFileHeader: bare,
    }),
    [base, bare],
  );
  return (
    <CodeBoundary fallback={fallback}>
      <div className={bare ? undefined : CARD}>
        <FileDiff
          fileDiff={file}
          options={options}
          lineAnnotations={annotations}
          renderAnnotation={renderAnnotation}
        />
      </div>
    </CodeBoundary>
  );
};

/**
 * The ReadDiff tool prefixes the patch with a PR header; the diff
 * proper starts at the `--- diff ---` marker (or the first
 * `diff --git`). Returns the header text and the patch, split.
 */
export const splitDiffOutput = (
  output: string,
): { header: string; patch: string | undefined } => {
  const marker = output.indexOf("--- diff ---");
  if (marker >= 0) {
    return {
      header: output.slice(0, marker).trimEnd(),
      patch: output.slice(marker + "--- diff ---".length).trim() || undefined,
    };
  }
  const git = output.indexOf("diff --git");
  if (git >= 0) {
    return {
      header: output.slice(0, git).trimEnd(),
      patch: output.slice(git),
    };
  }
  return { header: output, patch: undefined };
};
