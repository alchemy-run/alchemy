import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { truncateTail } from "../sandbox/Output.ts";
import { Artifacts } from "../sandbox/Artifacts.ts";

export const command = AI.Parameter("command", S.String)`
A shell command run with 'sh -c' at the workspace root. Chain steps
with '&&'; quote paths containing spaces.`;

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
const MAX_LINES = 2000;
const MAX_BYTES = 50_000;

/** Physics over the session {@link AI.Sandbox}. */
export const BashLive = Layer.effect(
  Bash,
  Effect.gen(function* () {
    const sandbox = yield* AI.Sandbox;
    const artifacts = yield* Artifacts;

    // Show a bounded preview; retain the complete (sandbox-retained)
    // output as an opaque artifact readable with readOutput.
    const channel = (label: string, text: string, dropped: boolean) =>
      Effect.gen(function* () {
        const preview = truncateTail(text, {
          maxLines: MAX_LINES,
          maxBytes: MAX_BYTES,
        });
        if (!preview.truncated && !dropped) {
          return { text: preview.text, note: "" };
        }
        const artifact = yield* artifacts.create(label);
        yield* artifact.append(text);
        return {
          text: preview.text,
          note: `\nFull ${label}: ${artifact.id}`,
        };
      });

    return ((input: { command: string; timeout?: number }) =>
      Effect.gen(function* () {
        const result = yield* sandbox.exec(input.command, undefined, {
          timeout: (input.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
        });
        const stdout = yield* channel(
          "stdout",
          result.stdout,
          result.stdoutTruncated,
        );
        const stderr = yield* channel(
          "stderr",
          result.stderr,
          result.stderrTruncated,
        );
        return (
          `exit: ${result.exitCode}\n` +
          `--- stdout ---\n${stdout.text || "(no output)"}` +
          stdout.note +
          `\n--- stderr ---\n${stderr.text || "(no output)"}` +
          stderr.note
        );
      })) as never;
  }),
);
