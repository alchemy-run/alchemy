import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { truncateHead } from "../lib/Output.ts";
import { ToolOutputStore } from "../lib/ToolOutputStore.ts";
import { pattern } from "../Vocabulary.ts";

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

const MAX_BYTES = 50_000;

/**
 * Physics: ripgrep run through the session {@link AI.Sandbox} (rg is
 * part of every sandbox image; the trusted host needs it on PATH).
 */
export const GrepLive = Layer.effect(
  Grep,
  Effect.gen(function* () {
    const sandbox = yield* AI.Sandbox;
    const store = yield* ToolOutputStore;

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
          input.path ?? ".",
        ];
        const result = yield* sandbox.exec("rg", args, {
          timeout: (input.multiline ? 60 : 20) * 1000,
        });

        // rg exit 1 = no matches; 127 = rg missing; >1 = bad input.
        if (result.exitCode === 1) return "no matches";
        if (result.exitCode === 127) {
          return yield* Effect.fail(
            "ripgrep (rg) is required for grep but was not found on PATH",
          );
        }
        if (result.exitCode > 1) {
          return yield* Effect.fail(
            `grep failed (exit ${result.exitCode}): ${result.stderr || "check the pattern and filters"}`,
          );
        }
        const cleaned = result.stdout.replaceAll(/^\.\/+/gm, "").trim();
        if (cleaned.length === 0) return "no matches";
        const preview = truncateHead(cleaned, {
          maxLines: max,
          maxBytes: MAX_BYTES,
        });
        if (!preview.truncated) return preview.text;
        const artifact = yield* store.create("grep");
        yield* artifact.append(cleaned);
        return `${preview.text}\n[Output truncated: ${preview.shownLines} of ${preview.totalLines} lines shown. Full output: ${artifact.id}]`;
      })) as never;
  }),
);
