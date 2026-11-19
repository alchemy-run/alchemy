import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Golden } from "./Golden.ts";

/**
 * Starts sandboxes from the Golden snapshot while it runs: a fresh one per
 * `/run`, deleted when the request ends, and one per user that keeps their
 * changes and resumes when they come back.
 */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sandboxes = yield* Boat.CreateSandbox(Golden);

    /** Runs a command in the repository, in a fresh sandbox deleted when the request ends. */
    const run = Effect.fn("run")(function* (command: string) {
      const sandbox = yield* Effect.acquireRelease(
        sandboxes.create({ noEnv: true, autoStop: "5 minutes" }),
        (sandbox) => Effect.ignore(sandbox.delete()),
      );
      return yield* sandbox.exec(command, { cwd: "/home/user/repo", timeout: "1 minute" });
    });

    /** The user's sandbox: found by label and resumed, or started from Golden. */
    const userSandbox = Effect.fn("userSandbox")(function* (user: string) {
      const [existing] = yield* sandboxes.list({ labels: { user } });
      if (existing === undefined) {
        return yield* sandboxes.create({ noEnv: true, autoStop: "10 minutes", labels: { user } });
      }
      const sandbox = yield* sandboxes.connect(existing.id);
      yield* sandbox.resume({ autoStop: "10 minutes" });
      return sandbox;
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
          const owned = yield* sandboxes.list({ labels: { user } });
          yield* Effect.forEach(owned, (sandbox) => sandboxes.delete(sandbox.id));
          return HttpServerResponse.empty({ status: 204 });
        }

        const match = /^\/users\/([a-z0-9-]+)\/files\/(.+)$/.exec(url.pathname);
        if (match !== null) {
          const [, owner, file] = match as unknown as [string, string, string];
          const sandbox = yield* userSandbox(owner);
          if (request.method === "PUT") {
            yield* sandbox.files.write(`repo/${file}`, yield* request.text);
          }
          const content = yield* sandbox.files.readText(`repo/${file}`);
          return yield* HttpServerResponse.json({ sandboxId: sandbox.sandboxId, content });
        }

        if (url.pathname === "/") return HttpServerResponse.text("ok");
        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Boat.CreateSandboxHttp)),
) {}
