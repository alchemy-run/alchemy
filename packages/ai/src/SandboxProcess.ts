/**
 * A long-running command in a sandbox, with a byte stream in and a byte
 * stream out, over the two calls every sandbox platform has: a command run
 * to completion, and a background command whose output is followed.
 *
 * The command's own stdin is not used. Platforms differ too much there:
 * some pass bytes, some only text, some close it after the first write,
 * some have none. Instead the command reads a FIFO, and each batch of bytes
 * is written to it by its own short command. The command's output is
 * printed as base64 lines, so it survives a platform that carries output
 * as text.
 *
 * @internal
 * @module
 */
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { SandboxError, type SandboxHandle } from "./Sandbox.ts";

/**
 * `$0` is the input FIFO, the rest the command. The shell holds the FIFO
 * open for reading and writing, so it never reaches end of file between
 * writers, and says so once it does. `dd count=1` returns what one read
 * gives, so output is forwarded as it arrives.
 */
const SERVE = `rm -f "$0"
mkfifo -m 600 "$0" || exit 1
exec <>"$0"
echo sp-ready
{ sh -c 'echo $$ >"$0.pid"; exec "$@"' "$0" "$@"; rm -f "$0" "$0.pid"; } | while :; do
  chunk=$(dd bs=12288 count=1 2>/dev/null | base64 | tr -d '\\n')
  [ -n "$chunk" ] || break
  printf 'sp:%s\\n' "$chunk"
done`;

/** `$0` is the FIFO, `$1` the bytes in base64. Fails once the command is gone. */
const SEND = `[ -p "$0" ] && printf %s "$1" | base64 -d >"$0"`;

/** `$0` is the FIFO. */
const STOP = `[ -f "$0.pid" ] && kill "$(cat "$0.pid")" 2>/dev/null; true`;

/** Bytes per `SEND`: its base64 stays far below the 128 KiB Linux allows one argument. */
const SEND_BYTES = 30 * 1024;

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

const messageOf = (cause: unknown): string =>
  cause !== null && typeof cause === "object" && "message" in cause
    ? String((cause as { message: unknown }).message)
    : String(cause);

const failed = (operation: string) => (cause: unknown) =>
  new SandboxError({ operation, code: "unknown", message: messageOf(cause) });

export interface SandboxProcess {
  /** What the command writes to its stdout, until it exits. */
  readonly output: Stream.Stream<Uint8Array, SandboxError>;
  /** Bytes for the command's stdin. Writes are delivered in order. */
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, SandboxError>;
  /** What the command has written to its stderr so far: why it exited, when it did. */
  readonly errors: Effect.Effect<string>;
}

/**
 * Start `command` in `sandbox` and connect to its stdin and stdout. `fifo`
 * is a path in the sandbox no other process uses. The command is killed
 * when the scope closes.
 */
export const openProcess = (
  sandbox: SandboxHandle,
  options: { readonly fifo: string; readonly command: ReadonlyArray<string> },
): Effect.Effect<SandboxProcess, SandboxError, RuntimeContext | Scope.Scope> =>
  Effect.gen(function* () {
    const { fifo } = options;
    const context = yield* Effect.context<RuntimeContext>();
    const process = yield* sandbox
      .start(["sh", "-c", SERVE, fifo, ...options.command])
      .pipe(Effect.mapError(failed("start")));
    yield* Effect.addFinalizer(() =>
      sandbox
        .exec(["sh", "-c", STOP, fifo], { timeout: "30 seconds" })
        .pipe(
          Effect.ignore,
          Effect.andThen(Effect.ignore(process.kill())),
          Effect.provideContext(context),
        ),
    );

    const output = yield* Queue.unbounded<Uint8Array, SandboxError | Cause.Done>();
    const ready = yield* Queue.unbounded<true, SandboxError | Cause.Done>();
    const decoder = new TextDecoder();
    const stderr = new TextDecoder();
    let errors = "";
    let text = "";
    yield* process.output.pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          if (chunk.fd !== "stdout") {
            errors = (errors + stderr.decode(chunk.data, { stream: true })).slice(-4000);
            return;
          }
          text += decoder.decode(chunk.data, { stream: true });
          const lines = text.split("\n");
          text = lines.pop() ?? "";
          for (const line of lines) {
            const encoded = /^sp:([A-Za-z0-9+/=]+)\r?$/.exec(line)?.[1];
            if (encoded !== undefined) Queue.offerUnsafe(output, fromBase64(encoded));
            else if (line.startsWith("sp-ready")) Queue.offerUnsafe(ready, true);
          }
        }),
      ),
      Effect.mapError(failed("output")),
      Effect.exit,
      Effect.flatMap((exit) =>
        (exit._tag === "Success" ? Queue.end(output) : Queue.failCause(output, exit.cause)).pipe(
          Effect.andThen(Queue.end(ready)),
        ),
      ),
      Effect.provideContext(context),
      Effect.forkScoped,
    );
    // Nothing is sent before the script says the FIFO exists.
    yield* Queue.take(ready).pipe(
      Effect.mapError(
        () =>
          new SandboxError({
            operation: "start",
            code: "unknown",
            message: `The command exited before it was ready: ${errors.trim() || "no output"}`,
          }),
      ),
    );

    const sending = yield* Semaphore.make(1);
    return {
      output: Stream.fromQueue(output),
      errors: Effect.sync(() => errors),
      write: (bytes) =>
        sending.withPermit(
          Effect.forEach(
            Array.from({ length: Math.ceil(bytes.length / SEND_BYTES) }, (_, index) =>
              bytes.subarray(index * SEND_BYTES, (index + 1) * SEND_BYTES),
            ),
            (chunk) =>
              sandbox
                .exec(["sh", "-c", SEND, fifo, toBase64(chunk)], { timeout: "30 seconds" })
                .pipe(
                  Effect.mapError(failed("write")),
                  Effect.flatMap((result) =>
                    result.exitCode === 0
                      ? Effect.void
                      : Effect.fail(
                          new SandboxError({
                            operation: "write",
                            code: "unknown",
                            message: `The command is no longer running: ${errors.trim() || `exited ${result.exitCode}`}`,
                          }),
                        ),
                  ),
                  Effect.provideContext(context),
                ),
            { discard: true },
          ),
        ),
    };
  });
