/**
 * Local physics for the Engineer's workspace tools — FileSystem / Path /
 * ChildProcess over a real checkout, sandboxed to a workspace root
 * (adapted from packages/alchemy/test/AI/fixtures/coding/toolbox.ts —
 * same contracts-vs-physics split, this is the laptop's physics; the
 * Cloudflare DevBox container is the same contract's future physics).
 *
 * Failure discipline: every operational error (missing file, escaped
 * path, timeout) is `Effect.fail(text)` — a model-visible tool failure
 * the agent reacts to — never a defect.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { Bash, EditFile, Grep, ReadFile } from "./tools.ts";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "lib"]);
const MAX_MATCHES = 200;
const BASH_TIMEOUT = "60 seconds";

/**
 * Local physics for Grep / ReadFile / EditFile / Bash, sandboxed to
 * `root`: paths resolve inside the workspace or fail model-visibly;
 * `bash` runs with `cwd = root` and a hard timeout.
 *
 * The entrypoint picks `root` (local.ts reads `FACTORY_WORKSPACE`).
 * TODO(workspace): the eventual default is a fresh temp CLONE of the
 * managed repository per run — the Workspace component from the
 * factory catalog (factory-components.md). Until then the operator
 * points the env var at an existing checkout.
 */
export const localCodingTools = (
  root: string,
): Layer.Layer<
  Grep | ReadFile | EditFile | Bash,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> => {
  const resolveSafe = Effect.fn(function* (relative: string) {
    const pathService = yield* Path.Path;
    const full = pathService.resolve(root, relative);
    if (full !== root && !full.startsWith(root + "/")) {
      return yield* Effect.fail(
        `path escapes the workspace: ${JSON.stringify(relative)}`,
      );
    }
    return full;
  });

  const readFileLayer = Layer.effect(
    ReadFile,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const context = yield* Effect.context<Path.Path>();
      return ((input: { path: string }) =>
        Effect.gen(function* () {
          const full = yield* resolveSafe(input.path);
          return yield* fs
            .readFileString(full)
            .pipe(Effect.mapError((error) => String(error)));
        }).pipe(Effect.provide(context))) as never;
    }),
  );

  const editFileLayer = Layer.effect(
    EditFile,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const context = yield* Effect.context<Path.Path>();
      return ((input: { path: string; content: string }) =>
        Effect.gen(function* () {
          const full = yield* resolveSafe(input.path);
          yield* fs
            .writeFileString(full, input.content)
            .pipe(Effect.mapError((error) => String(error)));
          return `wrote ${input.path} (${input.content.length} chars)`;
        }).pipe(Effect.provide(context))) as never;
    }),
  );

  const grepLayer = Layer.effect(
    Grep,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;

      const walk: (dir: string) => Effect.Effect<string[], string> = Effect.fn(
        function* (dir: string) {
          const entries = yield* fs
            .readDirectory(dir)
            .pipe(Effect.mapError((error) => String(error)));
          const files: string[] = [];
          for (const entry of entries) {
            if (SKIP_DIRS.has(entry)) continue;
            const full = pathService.join(dir, entry);
            const info = yield* fs
              .stat(full)
              .pipe(Effect.mapError((error) => String(error)));
            if (info.type === "Directory") {
              files.push(...(yield* walk(full)));
            } else if (info.type === "File") {
              files.push(full);
            }
          }
          return files;
        },
      );

      return ((input: { pattern: string }) =>
        Effect.gen(function* () {
          const regex = yield* Effect.try({
            try: () => new RegExp(input.pattern),
            catch: (error) => `invalid pattern: ${String(error)}`,
          });
          const files = yield* walk(root);
          const matches: string[] = [];
          for (const file of files) {
            const text = yield* fs
              .readFileString(file)
              .pipe(Effect.orElseSucceed(() => "")); // binary: skip
            const lines = text.split("\n");
            for (let index = 0; index < lines.length; index++) {
              if (regex.test(lines[index]!)) {
                matches.push(
                  `${pathService.relative(root, file)}:${index + 1}: ${lines[index]}`,
                );
                if (matches.length >= MAX_MATCHES) break;
              }
            }
            if (matches.length >= MAX_MATCHES) break;
          }
          return matches.length === 0 ? "no matches" : matches.join("\n");
        })) as never;
    }),
  );

  const bashLayer = Layer.effect(
    Bash,
    Effect.gen(function* () {
      const context = yield* Effect.context<ChildProcessSpawner>();
      return ((input: { command: string }) =>
        Effect.gen(function* () {
          const handle = yield* ChildProcess.make("sh", ["-c", input.command], {
            cwd: root,
          }).pipe(Effect.mapError((error) => String(error)));
          const [exitCode, stdout, stderr]: [number, string, string] =
            yield* Effect.all(
              [
                handle.exitCode,
                Stream.mkString(Stream.decodeText(handle.stdout)),
                Stream.mkString(Stream.decodeText(handle.stderr)),
              ] as const,
              { concurrency: 3 },
            ).pipe(
              Effect.mapError((error) => String(error)),
              Effect.timeoutOrElse({
                duration: BASH_TIMEOUT,
                orElse: () =>
                  Effect.fail(`command timed out after ${BASH_TIMEOUT}`),
              }),
            );
          return `exit ${exitCode}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;
        }).pipe(Effect.provide(context))) as never;
    }),
  );

  return Layer.mergeAll(readFileLayer, editFileLayer, grepLayer, bashLayer);
};
