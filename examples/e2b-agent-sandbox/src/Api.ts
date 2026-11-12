// src/Api.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Warm } from "./Sandbox.ts";

/**
 * Starts sandboxes from the Warm snapshot while it runs: a fresh one per
 * `/run`, killed when the request ends, and one per user that pauses with
 * their changes and resumes when they come back.
 */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sandboxes = yield* E2B.CreateSandbox(Warm);

    /** Runs a command in the repository, in a fresh sandbox killed when the request ends. */
    const run = Effect.fn("run")(function* (command: string) {
      const sandbox = yield* Effect.acquireRelease(sandboxes.create({ timeout: 120 }), (sandbox) =>
        Effect.ignore(sandbox.kill()),
      );
      return yield* sandbox.exec(command, { cwd: "/home/user/repo" });
    });

    /** The user's sandbox: found by metadata and resumed, or started from Warm. */
    const userSandbox = Effect.fn("userSandbox")(function* (user: string) {
      const [existing] = yield* sandboxes.list({
        metadata: { user },
        state: ["running", "paused"],
      });
      return existing !== undefined
        ? yield* sandboxes.connect(existing.sandboxID, { timeout: 600 })
        : yield* sandboxes.create({ metadata: { user }, timeout: 600, autoPause: true });
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");

        if (request.method === "POST" && url.pathname === "/run") {
          const result = yield* run(yield* request.text).pipe(Effect.scoped);
          return yield* HttpServerResponse.json(result);
        }

        const user = /^\/users\/([a-z0-9-]+)$/.exec(url.pathname)?.[1];
        if (request.method === "DELETE" && user !== undefined) {
          const owned = yield* sandboxes.list({ metadata: { user } });
          yield* Effect.forEach(owned, (s) => sandboxes.kill(s.sandboxID));
          return HttpServerResponse.empty({ status: 204 });
        }

        const match = /^\/users\/([a-z0-9-]+)\/files\/(.+)$/.exec(url.pathname);
        if (match !== null) {
          const [, owner, file] = match as unknown as [string, string, string];
          const sandbox = yield* userSandbox(owner);
          if (request.method === "PUT") {
            yield* sandbox.files.write(`/home/user/repo/${file}`, yield* request.text);
          }
          const content = yield* sandbox.files.readText(`/home/user/repo/${file}`);
          yield* sandbox.pause();
          return yield* HttpServerResponse.json({ sandboxId: sandbox.sandboxId, content });
        }

        if (url.pathname === "/") return HttpServerResponse.text("ok");
        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(E2B.CreateSandboxHttp)),
) {}
