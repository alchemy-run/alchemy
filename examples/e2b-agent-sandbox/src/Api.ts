// src/Api.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Agent } from "./Sandbox.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sandboxes = yield* E2B.CreateSandbox(Agent);
    const volumes = yield* E2B.CreateVolume();

    /** Runs a script in a fresh sandbox that is killed when the request ends. */
    const run = Effect.fn("run")(function* (code: string) {
      const sandbox = yield* Effect.acquireRelease(
        sandboxes.create({ timeout: 120, network: { allowOut: [] } }),
        (sandbox) => Effect.ignore(sandbox.kill()),
      );
      yield* sandbox.files.write("main.mjs", code);
      return yield* sandbox.exec("node main.mjs");
    });

    /** The user's sandbox: found by metadata, resumed if paused, created with their volume. */
    const userSandbox = Effect.fn("userSandbox")(function* (user: string) {
      const home = yield* volumes.getOrCreate(`home-${user}`);
      const [existing] = yield* sandboxes.list({
        metadata: { user },
        state: ["running", "paused"],
      });
      return existing !== undefined
        ? yield* sandboxes.connect(existing.sandboxID, { timeout: 600 })
        : yield* sandboxes.create({
            metadata: { user },
            timeout: 600,
            autoPause: true,
            mounts: [{ volume: home, path: "/home/user/work" }],
          });
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
          const sandboxesOfUser = yield* sandboxes.list({ metadata: { user } });
          yield* Effect.forEach(sandboxesOfUser, (s) => sandboxes.kill(s.sandboxID));
          const home = yield* volumes.get(`home-${user}`);
          if (home !== undefined) yield* volumes.delete(home.volumeId);
          return HttpServerResponse.empty({ status: 204 });
        }

        const match = /^\/users\/([a-z0-9-]+)\/files\/(.+)$/.exec(url.pathname);
        if (match !== null) {
          const [, user, file] = match as unknown as [string, string, string];
          const sandbox = yield* userSandbox(user);
          if (request.method === "PUT") {
            const content = yield* request.text;
            yield* sandbox.files.write(`/home/user/work/${file}`, content);
          }
          const listing = yield* sandbox.exec(["ls", "-1", "/home/user/work"]);
          const content = yield* sandbox.files.readText(`/home/user/work/${file}`);
          yield* sandbox.pause();
          return yield* HttpServerResponse.json({
            sandboxId: sandbox.sandboxId,
            files: listing.stdout.split("\n").filter(Boolean),
            content,
          });
        }

        if (url.pathname === "/") return HttpServerResponse.text("ok");
        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(E2B.CreateSandboxHttp, E2B.CreateVolumeHttp))),
) {}
