import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default Effect.gen(function* () {
  // const queue = yield* Cloudflare.Queue("ProfileChanges");

  // const { send } = yield* Cloudflare.bind(queue);

  const users = yield* Cloudflare.DurableObjectNamespace(
    "Users",
    Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      return {
        getProfile: () => state.storage.get("Profile"),
        putProfile: Effect.fnUntraced(function* (value: string) {
          yield* state.storage.put("Profile", value);
          // yield* send(value);
        }),
      };
    }),
  );

  // const sandbox = yield* Cloudflare.Container(
  //   "Sandbox",
  //   {
  //     instanceType: "standard-1",
  //     dockerfile: `
  //       FROM alpine:latest
  //       RUN apk add --no-cache ffmpeg
  //     `,
  //   },
  //   Effect.gen(function* () {
  //     const cmd = yield* ChildProcess.make("ffmpeg", ["-version"]);
  //     const [exitCode, stdout, stderr] = yield* Effect.all(
  //       [
  //         cmd.exitCode,
  //         Stream.mkString(Stream.decodeText(cmd.stdout)),
  //         Stream.mkString(Stream.decodeText(cmd.stderr)),
  //       ] as const,
  //       { concurrency: "unbounded" },
  //     );
  //     return yield* HttpServerResponse.json({ stdout, stderr, exitCode });
  //   }),
  // );

  return Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    if (request.url.includes("/data")) {
      const key = request.url.split("/").pop()!;
      const user = yield* users.getByName(key);
      if (request.method == "GET") {
        const item = yield* user.getProfile();
        if (item) {
          return HttpServerResponse.text(item);
        }
      } else if (request.method == "PUT") {
        yield* user.putProfile(yield* request.text);
        return HttpServerResponse.text("OK", { status: 200 });
      } else {
        return HttpServerResponse.text("Method not allowed", { status: 405 });
      }
    } else if (request.url.includes("/sandbox")) {
      return yield* sandbox.fetch(request);
    }
    return HttpServerResponse.text("Not found", { status: 404 });
  });
}).pipe(
  Effect.provide(
    Layer.provideMerge(
      Layer.mergeAll(
        Cloudflare.Queue.QueueLive,
        Cloudflare.Queue.QueueSinkLive,
      ),
      Layer.mergeAll(Cloudflare.DurableObjectNamespace),
    ),
  ),
  Cloudflare.Worker("site", import.meta.filename),
);
