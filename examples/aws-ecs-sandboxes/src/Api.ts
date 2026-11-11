// src/Api.ts
import * as AWS from "@alchemy.run/aws";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Capacity } from "./Infra.ts";
import MySandbox from "./MySandbox.ts";

/**
 * Keeps one sandbox per user and runs the code they send in it.
 *
 * - `POST /users/<user>/run` runs the request body as a TypeScript program.
 * - `DELETE /users/<user>` kills the user's sandbox.
 */
export default class Api extends AWS.Lambda.Function<Api>()(
  "Api",
  {
    main: import.meta.url,
    functionUrl: true,
    // The first sandbox waits for ECS to launch an instance.
    timeout: Duration.minutes(6),
  },
  Effect.gen(function* () {
    const sandboxes = yield* AWS.ECS.CreateSandbox(Capacity, MySandbox);

    /** The user's sandbox: found by its tag, or started. */
    const userSandbox = Effect.fn("userSandbox")(function* (user: string) {
      const [existing] = yield* sandboxes.list({ tags: { user } });
      return existing !== undefined
        ? yield* sandboxes.connect(existing.taskArn)
        : yield* sandboxes.create({ tags: { user }, idleTimeout: "15 minutes" });
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");

        const user = /^\/users\/([a-z0-9-]+)(\/run)?$/.exec(url.pathname);
        if (user === null) return HttpServerResponse.text("not found", { status: 404 });
        const [, name, run] = user as unknown as [string, string, string | undefined];

        if (request.method === "POST" && run !== undefined) {
          const sandbox = yield* userSandbox(name);
          yield* sandbox.files.write("/work/main.ts", yield* request.text);
          const result = yield* sandbox.exec("bun main.ts", { cwd: "/work", timeout: "1 minute" });
          const greeting = yield* sandbox.hello(name);
          return yield* HttpServerResponse.json({ greeting, ...result });
        }

        if (request.method === "DELETE" && run === undefined) {
          const owned = yield* sandboxes.list({ tags: { user: name } });
          yield* Effect.forEach(
            owned,
            Effect.fn(function* (info) {
              const sandbox = yield* sandboxes.connect(info.taskArn);
              yield* sandbox.kill();
            }),
          );
          return HttpServerResponse.empty({ status: 204 });
        }

        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(AWS.ECS.CreateSandboxHttp)),
) {}
