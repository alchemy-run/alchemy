/**
 * `exec` inside a sandbox that runs Alchemy's bootstrap: serves one process
 * per socket, speaking `AI/SandboxExecProtocol.ts`. Mounted on the control
 * server (`GET /exec`, behind its bearer secret), so any host that reaches
 * the control port can run commands: a MicroVM today, any process host
 * (ECS, Fly, a local process) the same way.
 *
 * @internal
 */
import * as cp from "node:child_process";
import * as os from "node:os";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import {
  decodeFrame,
  encodeControl,
  encodeData,
  ExecChannel,
  type ExecStart,
} from "./SandboxExecProtocol.ts";

const signalNumber = (signal: NodeJS.Signals): number => os.constants.signals[signal] ?? 15;

/** Read frames until `Start` (anything before it is a protocol error). */
const readStart = (reader: Socket.Reader) =>
  Effect.gen(function* () {
    const frames = yield* reader.pull;
    const first = decodeFrame(frames[0]);
    if (first?.channel !== ExecChannel.control || first.message._tag !== "Start") {
      return { start: undefined, rest: [] as ReadonlyArray<Uint8Array | string> };
    }
    return { start: first.message as ExecStart, rest: frames.slice(1) };
  });

/** Serve one `exec` on `socket`: spawn, pump stdio, report the exit code. */
export const serveExec = (socket: Socket.Socket): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const reader = yield* socket.reader;
    const writer = yield* socket.writer;
    const { start, rest } = yield* readStart(reader);
    if (!start || start.cmd.length === 0) {
      yield* writer.write(
        encodeControl({ _tag: "Failed", message: "expected Start with a command" }),
      );
      return;
    }
    const argv = start.user ? ["runuser", "-u", start.user, "--", ...start.cmd] : [...start.cmd];
    const child = yield* Effect.try({
      try: () =>
        cp.spawn(argv[0]!, argv.slice(1), {
          cwd: start.cwd,
          env: { ...process.env, ...start.env },
          stdio: [
            start.stdin ? "pipe" : "ignore",
            start.stdout === "pipe" ? "pipe" : "ignore",
            start.stderr === "ignore" ? "ignore" : "pipe",
          ],
        }),
      catch: (cause) => cause,
    }).pipe(Effect.option);
    if (child._tag === "None") {
      yield* writer.write(encodeControl({ _tag: "Failed", message: `failed to spawn ${argv[0]}` }));
      return;
    }
    const proc = child.value;
    // A process that outlives its socket is killed with it.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      }),
    );

    // One queue keeps output frames in order, and `Exit` after all of them.
    const out = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const failed = yield* Effect.callback<string | undefined>((resume) => {
      proc.once("spawn", () => resume(Effect.succeed(undefined)));
      proc.once("error", (error) => resume(Effect.succeed(error.message)));
    });
    if (failed !== undefined) {
      yield* writer.write(encodeControl({ _tag: "Failed", message: failed }));
      return;
    }
    yield* Effect.sync(() => {
      Queue.offerUnsafe(out, encodeControl({ _tag: "Started", pid: proc.pid ?? 0 }));
      proc.stdout?.on("data", (chunk: Buffer) =>
        Queue.offerUnsafe(out, encodeData(ExecChannel.stdout, chunk)),
      );
      proc.stderr?.on("data", (chunk: Buffer) =>
        Queue.offerUnsafe(
          out,
          encodeData(start.stderr === "combined" ? ExecChannel.stdout : ExecChannel.stderr, chunk),
        ),
      );
      // `close` follows the end of stdout and stderr: Exit is the last frame.
      proc.once("close", (code, signal) => {
        const exit = code ?? (signal ? 128 + signalNumber(signal) : 1);
        Queue.offerUnsafe(out, encodeControl({ _tag: "Exit", code: exit }));
        Queue.endUnsafe(out);
      });
    });

    const apply = (frame: Uint8Array | string) =>
      Effect.sync(() => {
        const decoded = decodeFrame(frame);
        if (decoded === undefined) return;
        if (decoded.channel === ExecChannel.stdin) {
          proc.stdin?.write(decoded.data);
        } else if (decoded.channel === ExecChannel.control) {
          const message = decoded.message;
          if (message._tag === "Eof") proc.stdin?.end();
          if (message._tag === "Kill") proc.kill(message.signal ?? "SIGTERM");
        }
      });
    // stdin and control from the client, until the socket closes.
    yield* Effect.forEach(rest, apply, { discard: true });
    yield* reader.pull.pipe(
      Effect.flatMap((frames) => Effect.forEach(frames, apply, { discard: true })),
      Effect.forever,
      Effect.ignore,
      Effect.forkScoped,
    );

    yield* Stream.fromQueue(out).pipe(
      Stream.runForEach((frame) => writer.write(frame)),
      Effect.ignore,
    );
    yield* writer.write(new Socket.CloseEvent(1000, "exited")).pipe(Effect.ignore);
  }).pipe(Effect.catchCause(() => Effect.void));
