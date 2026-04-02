import * as Cloudflare from "alchemy-effect/Cloudflare";
import { Stack } from "alchemy-effect/Stack";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { PlatformError } from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

export class EvalError extends Data.TaggedError("EvalError")<{
  message: string;
}> {}

export class Sandbox extends Cloudflare.Container<
  Sandbox,
  {
    /**
     * Execute a command in a sandbox.
     */
    exec: (command: string) => Effect.Effect<
      {
        exitCode: number;
        stdout: string;
        stderr: string;
      },
      PlatformError
    >;
    /**
     * Evaluate JavaScript code in a sandbox.
     */
    eval: (code: string) => Effect.Effect<any, EvalError>;
  }
>()(
  "Sandbox",
  Stack.useSync((stack) => ({
    main: import.meta.path,
    // handler: "SandboxLive",
    instanceType: stack.stage === "prod" ? "standard-1" : "dev",
    dockerfile: `FROM alpine:latest`,
  })),
) {}

export const SandboxLive = Sandbox.make(
  Effect.gen(function* () {
    const cp = yield* ChildProcessSpawner;

    // return http effect
    return Sandbox.of({
      exec: (command) =>
        cp
          .spawn(
            ChildProcess.make(command, {
              shell: true,
            }),
          )
          .pipe(
            Effect.flatMap((handle) =>
              Effect.all(
                [
                  handle.exitCode,
                  Stream.mkString(Stream.decodeText(handle.stdout)),
                  Stream.mkString(Stream.decodeText(handle.stderr)),
                ],
                { concurrency: "unbounded" },
              ),
            ),
            Effect.map(([exitCode, stdout, stderr]) => {
              return { exitCode, stdout, stderr };
            }),
            Effect.scoped,
          ),
      eval: (code) =>
        Effect.try({
          // TODO(sam): evaluate in a sandbox
          // oxlint-disable-next-line no-eval
          try: () => eval(code),
          catch: (error: any) => new EvalError({ message: error.message }),
        }),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        // upgrade to web socket
        const socket = yield* request.upgrade;
        const writeMessage = yield* socket.writer;
        const cmd = yield* ChildProcess.make("ffmpeg", ["-version"]);
        const [exitCode] = yield* Effect.all(
          [
            cmd.exitCode,
            // pipe stdout to the websocket
            cmd.stdout.pipe(
              Stream.tap(writeMessage),
              Stream.decodeText,
              Stream.mkString,
            ),
          ] as const,
          { concurrency: "unbounded" },
        );

        return HttpServerResponse.empty({
          status: exitCode === 0 ? 200 : 500,
        });
      }).pipe(Effect.orDie),
    });
  }),
);

export default SandboxLive;
