import * as Cloudflare from "alchemy-effect/Cloudflare";
import { Stack } from "alchemy-effect/Stack";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

export class Sandbox extends Cloudflare.Container<Sandbox>()(
  "Sandbox",
  Stack.useSync(
    (stack) =>
      ({
        main: import.meta.path,
        // handler: "SandboxLive",
        instanceType: stack.stage === "prod" ? "standard-1" : "dev",
        dockerfile: `
          FROM alpine:latest
          RUN apk add --no-cache ffmpeg
        `,
      }) satisfies Cloudflare.ContainerProps,
  ),
) {}

// dual entrypoint
// 1. main (runtime)
// 2. stack layer (infrastructure)
export const SandboxLive = Sandbox.make(
  Effect.gen(function* () {
    // bind dependencies
    // yield* Cloudflare.Queue()

    // return http effect
    return Effect.gen(function* () {
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
    }).pipe(Effect.orDie);
  }),
);

export default SandboxLive;
