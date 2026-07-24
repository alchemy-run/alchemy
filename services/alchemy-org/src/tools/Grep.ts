import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as S from "effect/Schema";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { runProcess } from "../internal/ProcessRunner.ts";
import { ToolOutputStore } from "../internal/ToolOutputStore.ts";
import { pattern } from "../vocabulary.ts";
import { Workspace } from "../workspace.ts";

const pathParam = AI.Parameter("path", S.optionalKey(S.String))`
Workspace-relative file or directory to search (default: ".").`;

const glob = AI.Parameter("glob", S.optionalKey(S.String))`
Glob filter for files, e.g. "*.ts", "*.{ts,tsx}", or
"src/**/*.spec.ts".
Omit to search everything.`;

const type = AI.Parameter("type", S.optionalKey(S.String))`
Ripgrep file type filter such as "ts", "rust", or "py". Use only
when sure of the registered type.`;

const ignoreCase = AI.Parameter("ignoreCase", S.optionalKey(S.Boolean))`
Case-insensitive search (default false).`;

const literal = AI.Parameter("literal", S.optionalKey(S.Boolean))`
Treat pattern as literal text instead of regex (default false).`;

const context = AI.Parameter(
  "context",
  S.optionalKey(
    S.Int.pipe(S.check(S.isGreaterThanOrEqualTo(0), S.isLessThanOrEqualTo(20))),
  ),
)`
Lines of context before and after each match (0-20, default 0).`;

const multiline = AI.Parameter("multiline", S.optionalKey(S.Boolean))`
Enable matches spanning multiple lines (default false; more expensive).`;

const outputMode = AI.Parameter(
  "outputMode",
  S.optionalKey(S.Literals(["content", "files", "count"])),
)`
"content" returns matching lines, "files" returns matching paths,
"count" returns match counts per file. Default "content".`;

const limit = AI.Parameter(
  "limit",
  S.optionalKey(
    S.Int.pipe(
      S.check(S.isGreaterThanOrEqualTo(1), S.isLessThanOrEqualTo(2000)),
    ),
  ),
)`
Maximum output lines to show (1-2000; default 100 for content and
500 for files/count). Complete truncated output is retained as an
artifact ID readable with readOutput.`;

export class Grep extends AI.Tool<Grep>()("grep")`
Fast content search across the whole workspace, at any repo size.
Searches file contents with ${pattern} — full regex syntax (e.g.
"log.*Error", "function\\s+\\w+"), so escape literal ".", "(", "["
etc. Scope with ${pathParam}, ${glob}, or ${type}; use ${literal},
${ignoreCase}, ${context}, and ${multiline} only when useful.
Choose ${outputMode} and bound the result with ${limit}. Respects
.gitignore and skips binaries. Always search before reading files;
use Glob for filename discovery.` {}

/**
 * Physics: ripgrep at the {@link Workspace} root (respects
 * `.gitignore`, skips binaries), falling back to `grep -rn` when `rg`
 * is not on PATH. The model never sees which ran.
 */
export const GrepLocal = Layer.effect(
  Grep,
  Effect.gen(function* () {
    const workspace = yield* Workspace;
    const path = yield* Path.Path;
    const environment = yield* Effect.context<
      ChildProcessSpawner | ToolOutputStore
    >();

    return ((input: {
      pattern: string;
      path?: string;
      glob?: string;
      type?: string;
      ignoreCase?: boolean;
      literal?: boolean;
      context?: number;
      multiline?: boolean;
      outputMode?: "content" | "files" | "count";
      limit?: number;
    }) =>
      Effect.gen(function* () {
        const mode = input.outputMode ?? "content";
        const max = input.limit ?? (mode === "content" ? 100 : 500);
        const root = yield* workspace.root;
        const target =
          input.path === undefined || input.path === "."
            ? "."
            : path.relative(
                root,
                yield* workspace.resolveExisting(input.path),
              );
        const args = [
          "--line-number",
          "--no-heading",
          "--color=never",
          "--hidden",
          "--glob",
          "!.git/*",
          "--max-columns=1000",
          "--max-columns-preview",
          ...(mode === "files" ? ["--files-with-matches"] : []),
          ...(mode === "count" ? ["--count"] : []),
          ...(input.glob ? ["--glob", input.glob] : []),
          ...(input.type ? ["--type", input.type] : []),
          ...(input.ignoreCase ? ["--ignore-case"] : []),
          ...(input.literal ? ["--fixed-strings"] : []),
          ...(input.context !== undefined && input.context > 0
            ? ["--context", String(input.context)]
            : []),
          ...(input.multiline ? ["--multiline"] : []),
          "--regexp",
          input.pattern,
          target,
        ];
        const result = yield* runProcess({
          command: "rg",
          args,
          cwd: root,
          timeoutSeconds: input.multiline ? 60 : 20,
          maxLines: max,
          maxBytes: 50_000,
          preview: "head",
        }).pipe(
          Effect.mapError((error) =>
            error.includes("ENOENT")
              ? "ripgrep (rg) is required for grep but was not found on PATH"
              : error,
          ),
        );

        // rg exit 1 = no matches; >1 is invalid input or runtime error.
        if (result.exitCode === 1) return "no matches";
        if (result.exitCode > 1) {
          return yield* Effect.fail(
            `grep failed (exit ${result.exitCode}): ${result.stderr.text || "check the pattern and filters"}`,
          );
        }
        const shown = result.stdout.text.replaceAll(/^\.\/+/gm, "").trim();
        if (shown.length === 0) return "no matches";
        return result.stdout.truncated
          ? `${shown}\n[Output truncated: ${result.stdout.shownLines} of ${result.stdout.totalLines} lines shown. Full output: ${result.stdout.outputId}]`
          : shown;
      }).pipe(Effect.provide(environment))) as never;
  }),
);
