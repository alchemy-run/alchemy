// src/Api.ts
import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Runs untrusted code in Boat sandboxes: a fresh sandbox per `/run`, and a
 * long-lived sandbox per user that stops when they're done and resumes with
 * their files when they come back.
 */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sandboxes = yield* Boat.CreateSandbox();

    /** Runs a script in a fresh sandbox that is deleted when the request ends. */
    const run = Effect.fn("run")(function* (code: string) {
      const sandbox = yield* Effect.acquireRelease(
        sandboxes.create({ type: "small", noEnv: true, ttlSeconds: 300 }),
        (sandbox) => Effect.ignore(sandbox.delete()),
      );
      yield* sandbox.files.write("main.mjs", code);
      return yield* sandbox.exec("node main.mjs", { timeout: "1 minute" });
    });

    /** The user's sandbox: found by label and resumed, or created. */
    const userSandbox = Effect.fn("userSandbox")(function* (user: string) {
      const [existing] = yield* sandboxes.list({ labels: { user } });
      if (existing === undefined) {
        return yield* sandboxes.create({
          type: "small",
          noEnv: true,
          ttlSeconds: 600,
          labels: { user },
        });
      }
      const sandbox = yield* sandboxes.connect(existing.id);
      yield* sandbox.resume({ ttlSeconds: 600 });
      return sandbox;
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");

        if (request.method === "POST" && url.pathname === "/run") {
          const code = yield* request.text;
          const result = yield* run(code).pipe(Effect.scoped);
          return yield* HttpServerResponse.json(result);
        }

        const user = /^\/users\/([a-z0-9-]+)$/.exec(url.pathname)?.[1];
        if (request.method === "DELETE" && user !== undefined) {
          const owned = yield* sandboxes.list({ labels: { user } });
          yield* Effect.forEach(owned, (sandbox) => sandboxes.delete(sandbox.id));
          return HttpServerResponse.empty({ status: 204 });
        }

        const match = /^\/users\/([a-z0-9-]+)\/files\/(.+)$/.exec(url.pathname);
        if (match !== null) {
          const [, owner, file] = match as unknown as [string, string, string];
          const sandbox = yield* userSandbox(owner);
          if (request.method === "PUT") {
            yield* sandbox.files.write(`work/${file}`, yield* request.text);
          }
          const listing = yield* sandbox.files.list("work");
          const content = yield* sandbox.files.readText(`work/${file}`);
          return yield* HttpServerResponse.json({
            sandboxId: sandbox.sandboxId,
            files: listing.map((entry) => entry.path.split("/").pop()),
            content,
          });
        }

        if (url.pathname === "/") return HttpServerResponse.text("ok");
        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Boat.CreateSandboxHttp)),
) {}
