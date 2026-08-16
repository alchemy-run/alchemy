import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { truncateHead } from "../lib/Output.ts";
import { Artifacts } from "../lib/Artifacts.ts";

const pattern = AI.Parameter("pattern", S.String)`
Glob pattern such as "*.ts", "**/*.json", or
"src/**/*.spec.ts". Omit no segments: "**" means recursive.`;

const pathParam = AI.Parameter("path", S.optionalKey(S.String))`
Workspace-relative directory to search (default: ".").`;

const limit = AI.Parameter(
  "limit",
  S.optionalKey(
    S.Int.pipe(
      S.check(S.isGreaterThanOrEqualTo(1), S.isLessThanOrEqualTo(5000)),
    ),
  ),
)`
Maximum paths to show (1-5000, default 1000). Complete truncated
output is retained as an artifact ID.`;

export class Glob extends AI.Tool<Glob>()("glob")`
Find files by ${pattern}, relative to ${pathParam}. Returns sorted
workspace-relative paths, respects .gitignore, and excludes .git.
Use for filename discovery; use grep for file contents. Bound output
with ${limit}.` {}

const MAX_BYTES = 50_000;

/** Physics: ripgrep file listing through the session {@link AI.Sandbox}. */
export const GlobLive = Layer.effect(
  Glob,
  Effect.gen(function* () {
    const sandbox = yield* AI.Sandbox;
    const artifacts = yield* Artifacts;
    return ((input: { pattern: string; path?: string; limit?: number }) =>
      Effect.gen(function* () {
        const max = input.limit ?? 1000;
        const result = yield* sandbox.exec(
          "rg",
          [
            "--files",
            "--hidden",
            "--sort",
            "path",
            "--glob",
            "!.git/*",
            "--glob",
            input.pattern,
            input.path ?? ".",
          ],
          { timeout: 20_000 },
        );
        if (result.exitCode === 127) {
          return yield* Effect.fail(
            "ripgrep (rg) is required for glob but was not found on PATH",
          );
        }
        if (result.exitCode > 1) {
          return yield* Effect.fail(
            `glob failed (exit ${result.exitCode}): ${result.stderr || "check the pattern and path"}`,
          );
        }
        const cleaned = result.stdout.replaceAll(/^\.\/+/gm, "").trim();
        if (cleaned.length === 0) return "no files found";
        const preview = truncateHead(cleaned, {
          maxLines: max,
          maxBytes: MAX_BYTES,
        });
        if (!preview.truncated) return preview.text;
        const artifact = yield* artifacts.create("glob");
        yield* artifact.append(cleaned);
        return `${preview.text}\n[Output truncated: ${preview.shownLines} of ${preview.totalLines} paths shown. Full output: ${artifact.id}]`;
      })) as never;
  }),
);
