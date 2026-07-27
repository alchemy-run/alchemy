import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import {
  HeadCollector,
  TailCollector,
  type TruncatedOutput,
} from "./Output.ts";
import { ToolOutputStore } from "./ToolOutputStore.ts";

export interface ProcessChannel extends TruncatedOutput {
  /** Present only when the inline preview was truncated. */
  readonly outputId?: string;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: ProcessChannel;
  readonly stderr: ProcessChannel;
}

const consume = (
  stream: Stream.Stream<Uint8Array, unknown>,
  label: string,
  options: {
    readonly maxLines: number;
    readonly maxBytes: number;
    readonly preview: "head" | "tail";
  },
) =>
  Effect.gen(function* () {
    const store = yield* ToolOutputStore;
    const artifact = yield* store.create(label);
    const collector =
      options.preview === "head"
        ? new HeadCollector(options)
        : new TailCollector(options);
    yield* Stream.runForEach(Stream.decodeText(stream), (chunk) =>
      artifact
        .append(chunk)
        .pipe(Effect.andThen(Effect.sync(() => collector.add(chunk)))),
    ).pipe(Effect.mapError((error) => String(error)));
    const result = collector.finish();
    return result.truncated ? { ...result, outputId: artifact.id } : result;
  });

/**
 * Run a scoped local process with bounded previews and complete
 * artifact capture. Timeout/interruption sends SIGTERM and escalates
 * to SIGKILL after one second.
 */
export const runProcess = (options: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly timeoutSeconds: number;
  readonly maxLines: number;
  readonly maxBytes: number;
  readonly preview?: "head" | "tail";
}): Effect.Effect<
  ProcessResult,
  string,
  ChildProcessSpawner | ToolOutputStore
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make(options.command, options.args, {
        cwd: options.cwd,
        detached: true,
      }).pipe(Effect.mapError((error) => String(error)));
      const terminate = handle
        .kill({ killSignal: "SIGTERM", forceKillAfter: "1 second" })
        .pipe(Effect.catch(() => Effect.void));

      const running = Effect.all(
        [
          handle.exitCode,
          consume(handle.stdout, "stdout", {
            ...options,
            preview: options.preview ?? "tail",
          }),
          consume(handle.stderr, "stderr", {
            ...options,
            preview: options.preview ?? "tail",
          }),
        ] as const,
        { concurrency: 3 },
      ).pipe(
        Effect.map(([exitCode, stdout, stderr]) => ({
          exitCode: exitCode as number,
          stdout,
          stderr,
        })),
        Effect.mapError((error) => String(error)),
        Effect.onInterrupt(() => terminate),
      );

      return yield* Effect.raceFirst(
        running,
        Effect.sleep(`${options.timeoutSeconds} seconds`).pipe(
          Effect.andThen(Effect.forkChild(terminate)),
          Effect.andThen(
            Effect.fail(
              `command timed out after ${options.timeoutSeconds} seconds — retry with a larger timeout if it needs longer`,
            ),
          ),
        ),
      );
    }),
  );
