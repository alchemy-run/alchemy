import { File, PatchDiff, type BaseCodeOptions } from "@pierre/diffs/react";
import { Component, memo, useMemo, type ReactNode } from "react";

/**
 * Code + diff rendering on @pierre/diffs — Shiki-highlighted, shadow
 * DOM–scoped, space-efficient. Two cards:
 *
 * - {@link CodeCard}: a highlighted code snippet (markdown fenced
 *   blocks, tool bodies). No header, no line numbers, wrapped — the
 *   chrome belongs to the surrounding card.
 * - {@link DiffCard}: a unified diff rendered from a patch string
 *   (ReadDiff tool output) — line numbers, word-level inline
 *   highlights, compact hunk separators.
 *
 Markdown language tag → file extension (Shiki detects by name). */
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

const BASE: BaseCodeOptions = {
  theme: "pierre-dark",
  themeType: "dark",
};

/** A highlighted snippet — fenced markdown blocks, inline tool code.
 */
export const CodeCard = memo(
  ({ code, language }: { code: string; language: string | undefined }) => {
    const file = useMemo(
      () => ({
        name: `snippet.${EXTENSION[language ?? ""] ?? language ?? "txt"}`,
        contents: code.replace(/\n$/, ""),
      }),
      [code, language],
    );
    const options = useMemo(
      () => ({
        ...BASE,
        disableFileHeader: true,
        disableLineNumbers: true,
        overflow: "wrap" as const,
      }),
      [],
    );
    return (
      <CodeBoundary fallback={code}>
        <div className="my-2 overflow-hidden rounded-md border border-border text-[13px]">
          <File file={file} options={options} />
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
const splitPatchFiles = (patch: string): string[] => {
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
  const files = useMemo(() => splitPatchFiles(patch), [patch]);
  const options = useMemo(
    () => ({
      ...BASE,
      diffStyle: "unified" as const,
      hunkSeparators: "metadata" as const,
      overflow: "scroll" as const,
    }),
    [],
  );
  return (
    <CodeBoundary fallback={patch}>
      {files.map((file, index) => (
        <div
          key={index}
          className="my-1 overflow-hidden rounded-md border border-border text-[13px]"
        >
          <PatchDiff patch={file} options={options} />
        </div>
      ))}
    </CodeBoundary>
  );
});
DiffCard.displayName = "DiffCard";

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
