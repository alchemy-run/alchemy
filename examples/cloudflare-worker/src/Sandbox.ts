import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

export const Sandbox = Cloudflare.Container(
  "Sandbox",
  {
    instanceType: "standard-1",
    dockerfile: `
          FROM alpine:latest
          RUN apk add --no-cache ffmpeg
        `,
  },
  // http effec
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const socket = yield* request.upgrade;

    const cmd = yield* ChildProcess.make("ffmpeg", ["-version"]);
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [
        cmd.exitCode,
        Stream.mkString(Stream.decodeText(cmd.stdout)),
        Stream.mkString(Stream.decodeText(cmd.stderr)),
      ] as const,
      { concurrency: "unbounded" },
    );

    return yield* HttpServerResponse.json({ stdout, stderr, exitCode });
  }),
);
