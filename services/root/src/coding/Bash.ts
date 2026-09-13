import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { Artifacts } from "../artifacts/Artifacts.ts";
import { truncateTail } from "../artifacts/Output.ts";

export const command = AI.Thing("command", S.String)`
  A shell command run with 'sh -c' at the root of your tree. Chain steps
  with '&&'; quote paths containing spaces.`;

const timeout = AI.Thing(
  "timeout",
  S.optionalKey(
    S.Int.pipe(
      S.check(S.isGreaterThanOrEqualTo(1), S.isLessThanOrEqualTo(3600)),
    ),
  ),
)`
  Timeout in seconds (1-3600, default 60). Increase it for long builds
  or test suites.`;

const exitCode = AI.Thing("exitCode", S.Int)`
  The command's exit code — 0 is success.`;

const stdout = AI.Thing("stdout", S.String)`
  The command's stdout, tail-truncated to the last 2000 lines / 50KB
  (the end of a build or test log is where the verdict is). When
  truncated, the full stream is retained and the note at the end names
  the opaque artifact ID readOutput can page.`;

const stderr = AI.Thing("stderr", S.String)`
  The command's stderr, truncated and retained exactly like stdout.`;

export class Bash extends (AI.Tool<Bash>(import.meta)("bash")`
  Run ${command} — answers ${AI.out(exitCode, stdout, stderr)}. Set
  ${timeout} for long test runs. Do NOT use bash for file operations —
  use grep instead of grep/rg/find, readFile instead of cat/head/tail,
  and editFile/writeFile instead of sed/awk/echo-redirection; the
  dedicated tools are cheaper, safer, and truncate for you. Prefer a
  single command chained with '&&' over multiple calls. If output is
  truncated, use readOutput with the returned opaque ID. The test suite
  is the only oracle of done-ness.`) {}

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
    const channel = Effect.fn(function* (
      label: string,
      text: string,
      dropped: boolean,
    ) {
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

    return Effect.fn(function* (input: { command: string; timeout?: number }) {
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
      return {
        exitCode: result.exitCode,
        stdout: stdout.text + stdout.note,
        stderr: stderr.text + stderr.note,
      };
    }) as never;
  }),
);
