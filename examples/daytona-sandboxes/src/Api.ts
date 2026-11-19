// src/Api.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Daytona from "@alchemy.run/daytona";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Warm } from "./Images.ts";

const REPO = "/home/daytona/repo";

/**
 * Starts sandboxes from the Warm snapshot while it runs: a fresh one per
 * `/run`, deleted when the request ends, and one per user that stops when
 * they're idle and starts again with their changes.
 */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sandboxes = yield* Daytona.CreateSandbox(Warm);

    /** Runs a command in the repository, in a fresh sandbox deleted when the request ends. */
    const run = Effect.fn("run")(function* (command: string) {
      const sandbox = yield* Effect.acquireRelease(sandboxes.create(), (s) =>
        sandboxes.delete(s.sandboxId).pipe(Effect.ignore),
      );
      return yield* sandbox.exec(command, { cwd: REPO });
    });

    /** The user's sandbox: found by name and started, or created from Warm. */
    const userSandbox = Effect.fn("userSandbox")(function* (user: string) {
      const existing = yield* sandboxes.get(`dev-${user}`);
      if (existing === undefined) {
        return yield* sandboxes.create({
          name: `dev-${user}`,
          labels: { user },
          autoStopInterval: 15,
        });
      }
      yield* existing.startSandbox();
      return existing;
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");

        if (request.method === "POST" && url.pathname === "/run") {
          return yield* HttpServerResponse.json(yield* run(yield* request.text));
        }

        const user = /^\/users\/([a-z0-9-]+)$/.exec(url.pathname)?.[1];
        if (request.method === "DELETE" && user !== undefined) {
          yield* sandboxes.delete(`dev-${user}`);
          return HttpServerResponse.empty({ status: 204 });
        }

        const match = /^\/users\/([a-z0-9-]+)\/files\/(.+)$/.exec(url.pathname);
        if (match !== null) {
          const [, owner, file] = match as unknown as [string, string, string];
          const sandbox = yield* userSandbox(owner);
          if (request.method === "PUT") {
            yield* sandbox.files.write(`${REPO}/${file}`, yield* request.text);
          }
          const content = yield* sandbox.files.readText(`${REPO}/${file}`);
          return yield* HttpServerResponse.json({ sandboxId: sandbox.sandboxId, content });
        }

        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(Effect.scoped, Effect.orDie),
    };
  }).pipe(Effect.provide(Daytona.CreateSandboxHttp)),
) {}
