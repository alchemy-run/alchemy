import type * as Cause from "effect/Cause";
/**
 * `exec` into a sandbox over a socket to its bootstrap's exec server
 * (`AI/SandboxExecProtocol.ts`). Host-agnostic: a host only supplies the
 * socket (a MicroVM's endpoint, a task's control port), and gets a
 * {@link SandboxProcess} back.
 *
 * @internal
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import type * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import {
  SandboxError,
  type SandboxExecOptions,
  type SandboxExecOutput,
  type SandboxProcess,
} from "./Sandbox.ts";
import { decodeFrame, encodeControl, encodeData, ExecChannel } from "./SandboxExecProtocol.ts";

const execError = (message: string) => (cause: unknown) =>
  new SandboxError({
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const concat = (chunks: ReadonlyArray<Uint8Array>): ArrayBuffer => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
};

/**
 * Run `cmd` through `socket` (one process per socket). The process lives as
 * long as the calling scope: closing it closes the socket, which kills the
 * process.
 */
export const execOverSocket = (
  socket: Socket.Socket,
  cmd: ReadonlyArray<string>,
  options: SandboxExecOptions = {},
): Effect.Effect<SandboxProcess, SandboxError, Scope.Scope> =>
  Effect.gen(function* () {
    if (options.pty) {
      return yield* new SandboxError({
        message: "exec with a pty is not supported on this host: run without `pty`.",
      });
    }
    const writer = yield* socket.writer;
    const reader = yield* socket.reader.pipe(Effect.mapError(execError("exec could not connect")));
    const send = (frame: Uint8Array) =>
      writer.write(frame).pipe(Effect.mapError(execError("exec connection failed")));

    const stdoutMode = options.stdout ?? "pipe";
    const stderrMode = options.stderr ?? "pipe";
    const stdout = yield* Queue.unbounded<Uint8Array, SandboxError | Cause.Done>();
    const stderr = yield* Queue.unbounded<Uint8Array, SandboxError | Cause.Done>();
    const started = yield* Deferred.make<number, SandboxError>();
    const exited = yield* Deferred.make<number, SandboxError>();
    const fail = (error: SandboxError) =>
      Effect.gen(function* () {
        yield* Deferred.fail(started, error);
        yield* Deferred.fail(exited, error);
        yield* Queue.fail(stdout, error);
        yield* Queue.fail(stderr, error);
      });

    // Frames from the server, until Exit (or the socket ends without one).
    yield* reader.pull.pipe(
      Effect.flatMap((frames) =>
        Effect.forEach(
          frames,
          (frame) =>
            Effect.gen(function* () {
              const decoded = decodeFrame(frame);
              if (decoded === undefined) return;
              if (decoded.channel === ExecChannel.stdout) yield* Queue.offer(stdout, decoded.data);
              else if (decoded.channel === ExecChannel.stderr)
                yield* Queue.offer(stderr, decoded.data);
              else if (decoded.channel === ExecChannel.control) {
                const message = decoded.message;
                if (message._tag === "Started") yield* Deferred.succeed(started, message.pid);
                if (message._tag === "Failed")
                  yield* fail(new SandboxError({ message: message.message }));
                if (message._tag === "Exit") {
                  yield* Queue.end(stdout);
                  yield* Queue.end(stderr);
                  yield* Deferred.succeed(exited, message.code);
                }
              }
            }),
          { discard: true },
        ),
      ),
      Effect.forever,
      Effect.catchCause(() =>
        fail(new SandboxError({ message: "the exec connection closed before the process exited" })),
      ),
      Effect.forkScoped,
    );

    const pipeStdin = options.stdin === "pipe";
    const streamStdin = options.stdin !== undefined && options.stdin !== "pipe";
    yield* send(
      encodeControl({
        _tag: "Start",
        cmd,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.user !== undefined ? { user: options.user } : {}),
        stdin: pipeStdin || streamStdin,
        stdout: stdoutMode,
        stderr: stderrMode,
      }),
    );
    const pid = yield* Deferred.await(started);

    const writeStdin = (chunk: Uint8Array) => send(encodeData(ExecChannel.stdin, chunk));
    const eof = send(encodeControl({ _tag: "Eof" }));
    if (streamStdin) {
      yield* Stream.fromReadableStream({
        evaluate: () => options.stdin as ReadableStream<Uint8Array>,
        onError: execError("reading exec stdin failed"),
      }).pipe(Stream.runForEach(writeStdin), Effect.andThen(eof), Effect.ignore, Effect.forkScoped);
    }

    const stdoutStream = stdoutMode === "pipe" ? Stream.fromQueue(stdout) : undefined;
    const stderrStream = stderrMode === "pipe" ? Stream.fromQueue(stderr) : undefined;
    const exitCode = Deferred.await(exited);
    const collect = (stream: Stream.Stream<Uint8Array, SandboxError> | undefined) =>
      stream
        ? Stream.runCollect(stream).pipe(Effect.map((chunks) => concat([...chunks])))
        : Effect.succeed(new ArrayBuffer(0));

    return {
      pid,
      isPty: false,
      stdin: pipeStdin
        ? Sink.forEach(writeStdin).pipe(Sink.ensuring(Effect.ignore(eof)))
        : undefined,
      stdout: stdoutStream,
      stderr: stderrStream,
      exitCode,
      output: () =>
        Effect.all([collect(stdoutStream), collect(stderrStream), exitCode], {
          concurrency: "unbounded",
        }).pipe(
          Effect.map(([out, err, code]): SandboxExecOutput => ({
            stdout: out,
            stderr: err,
            exitCode: code,
          })),
        ),
      kill: (signal) =>
        send(encodeControl(signal !== undefined ? { _tag: "Kill", signal } : { _tag: "Kill" })),
      resize: () =>
        Effect.fail(
          new SandboxError({ message: "resize needs a pty, which this host doesn't support." }),
        ),
    } satisfies SandboxProcess;
  });
