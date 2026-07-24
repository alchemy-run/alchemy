import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as S from "effect/Schema";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { runProcess } from "../internal/ProcessRunner.ts";
import { ToolOutputStore } from "../internal/ToolOutputStore.ts";
import { Workspace } from "alchemy/Workspace";

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

export const GlobLocal = Layer.effect(
  Glob,
  Effect.gen(function* () {
    const workspace = yield* Workspace;
    const path = yield* Path.Path;
    const environment = yield* Effect.context<
      ChildProcessSpawner | ToolOutputStore
    >();
    return ((input: { pattern: string; path?: string; limit?: number }) =>
      Effect.gen(function* () {
        const max = input.limit ?? 1000;
        const root = yield* workspace.root;
        const target =
          input.path === undefined || input.path === "."
            ? "."
            : path.relative(
                root,
                yield* workspace.resolveExisting(input.path),
              );
        const result = yield* runProcess({
          command: "rg",
          args: [
            "--files",
            "--hidden",
            "--sort",
            "path",
            "--glob",
            "!.git/*",
            "--glob",
            input.pattern,
            target,
          ],
          cwd: root,
          timeoutSeconds: 20,
          maxLines: max,
          maxBytes: 50_000,
          preview: "head",
        });
        if (result.exitCode > 1) {
          return yield* Effect.fail(
            `glob failed (exit ${result.exitCode}): ${result.stderr.text || "check the pattern and path"}`,
          );
        }
        const shown = result.stdout.text.replaceAll(/^\.\/+/gm, "").trim();
        if (shown.length === 0) return "no files found";
        return result.stdout.truncated
          ? `${shown}\n[Output truncated: ${result.stdout.shownLines} of ${result.stdout.totalLines} paths shown. Full output: ${result.stdout.outputId}]`
          : shown;
      }).pipe(Effect.provide(environment))) as never;
  }),
);
