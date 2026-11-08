import * as Archil from "@alchemy.run/archil";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Random from "effect/Random";
import { Golden } from "./Golden.ts";

/**
 * A program in its own Archil sandbox that forks Golden while it runs: a
 * fork per `/run`, deleted when the request ends, and a fork per user that
 * keeps their changes.
 */
export default class Api extends Archil.Sandbox<Api>()(
  "Api",
  { main: import.meta.url, port: 3000 },
  Effect.gen(function* () {
    const sandboxes = yield* Archil.CreateSandbox(Golden);

    /** Runs a command in the repository, in a fresh fork deleted when the request ends. */
    const run = Effect.fn("run")(function* (command: string) {
      const id = (yield* Random.nextIntBetween(0, 2 ** 31)).toString(36);
      const sandbox = yield* Effect.acquireRelease(
        sandboxes.create({ name: `run-${id}` }),
        (sandbox) => Effect.ignore(sandbox.delete()),
      );
      return yield* sandbox.exec(command, { cwd: "/work/is" });
    });

    /** The user's fork: found by name, or forked from Golden. */
    const userSandbox = Effect.fn("userSandbox")(function* (user: string) {
      return (
        (yield* sandboxes.get(`user-${user}`)) ??
        (yield* sandboxes.create({ name: `user-${user}` }))
      );
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");

        if (request.method === "POST" && url.pathname === "/run") {
          return yield* HttpServerResponse.json(
            yield* run(yield* request.text).pipe(Effect.scoped),
          );
        }

        const user = /^\/users\/([a-z0-9-]+)$/.exec(url.pathname)?.[1];
        if (request.method === "DELETE" && user !== undefined) {
          yield* sandboxes.delete(`user-${user}`);
          return HttpServerResponse.empty({ status: 204 });
        }

        const match = /^\/users\/([a-z0-9-]+)\/files\/(.+)$/.exec(url.pathname);
        if (match !== null) {
          const [, owner, file] = match as unknown as [string, string, string];
          const sandbox = yield* userSandbox(owner);
          if (request.method === "PUT") {
            yield* sandbox.files.write(`/work/is/${file}`, yield* request.text);
          }
          const content = yield* sandbox.files.readText(`/work/is/${file}`);
          return yield* HttpServerResponse.json({ sandboxId: sandbox.sandboxId, content });
        }

        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Archil.CreateSandboxHttp)),
) {}
