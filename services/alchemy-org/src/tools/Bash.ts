import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { runProcess } from "../lib/ProcessRunner.ts";
import { ToolOutputStore } from "../lib/ToolOutputStore.ts";
import { command } from "../Vocabulary.ts";
import { Workspace } from "alchemy/Workspace";

const timeout = AI.Parameter(
  "timeout",
  S.optionalKey(
    S.Int.pipe(
      S.check(S.isGreaterThanOrEqualTo(1), S.isLessThanOrEqualTo(3600)),
    ),
  ),
)`
Timeout in seconds (1-3600, default 60). Increase it for long builds
or test suites.`;

export class Bash extends AI.Tool<Bash>()("bash")`
Run ${command} and return its exit code, stdout, and stderr,
tail-truncated to the last 2000 lines / 50KB (the end of a build or
test log is where the verdict is). Set ${timeout} for long test
runs. Do NOT use bash for file operations — use grep instead of
grep/rg/find, readFile instead of cat/head/tail, and
editFile/writeFile instead of sed/awk/echo-redirection; the
dedicated tools are cheaper, safer, and truncate for you. Prefer a
single command chained with '&&' over multiple calls. If output is
truncated, use readOutput with the returned opaque ID. The test suite
is the only oracle of done-ness.` {}

const DEFAULT_TIMEOUT_SECONDS = 60;

/** Local physics: `sh -c` with `cwd` at the {@link Workspace} root. */
export const BashLocal = Layer.effect(
  Bash,
  Effect.gen(function* () {
    const workspace = yield* Workspace;
    const environment = yield* Effect.context<
      ChildProcessSpawner | ToolOutputStore
    >();
    return ((input: { command: string; timeout?: number }) =>
      Effect.gen(function* () {
        const root = yield* workspace.root;
        const result = yield* runProcess({
          command: "sh",
          args: ["-c", input.command],
          cwd: root,
          timeoutSeconds: input.timeout ?? DEFAULT_TIMEOUT_SECONDS,
          maxLines: 2000,
          maxBytes: 50_000,
          preview: "tail",
        });
        const artifact = (label: string, outputId: string | undefined) =>
          outputId === undefined ? "" : `\nFull ${label}: ${outputId}`;
        return (
          `exit: ${result.exitCode}\n` +
          `--- stdout ---\n${result.stdout.text || "(no output)"}` +
          artifact("stdout", result.stdout.outputId) +
          `\n--- stderr ---\n${result.stderr.text || "(no output)"}` +
          artifact("stderr", result.stderr.outputId)
        );
      }).pipe(Effect.provide(environment))) as never;
  }),
);
