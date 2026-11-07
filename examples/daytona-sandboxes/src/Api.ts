// src/Api.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Daytona from "@alchemy.run/daytona";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Base } from "./Images.ts";

const RunRequest = Schema.Struct({ command: Schema.String });

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    // Sandboxes start from Base; the Worker's key can only create and delete sandboxes.
    const sandboxes = yield* Daytona.CreateSandbox(Base);
    // One volume per user, named user-<id>.
    const volumes = yield* Daytona.CreateVolume({ prefix: "user-" });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const user = url.pathname.match(/^\/users\/([a-z0-9-]+)\/sandbox$/)?.[1];

        // POST /run — run a command in a fresh sandbox, then delete it.
        if (request.method === "POST" && url.pathname === "/run") {
          const { command } = yield* Schema.decodeUnknownEffect(RunRequest)(yield* request.json);
          const sandbox = yield* Effect.acquireRelease(sandboxes.create(), (s) =>
            sandboxes.delete(s.sandboxId).pipe(Effect.ignore),
          );
          const result = yield* sandbox.exec(command);
          return yield* HttpServerResponse.json(result);
        }

        // PUT /users/:user/sandbox — the user's sandbox, with their volume as home.
        if (request.method === "PUT" && user) {
          const home = yield* volumes.getOrCreate({ name: `user-${user}` });
          const existing = yield* sandboxes.get(`dev-${user}`);
          const sandbox =
            existing ??
            (yield* sandboxes.create({
              name: `dev-${user}`,
              labels: { user },
              mounts: [{ volume: home, path: "/home/daytona/work" }],
              autoStopInterval: 15,
            }));
          if (existing) yield* sandbox.startSandbox();
          // Volumes are backed by object storage: write a new file per visit
          // rather than appending to one.
          yield* sandbox.exec(
            "mkdir -p /home/daytona/work/visits && date > /home/daytona/work/visits/$(date +%s%N)",
          );
          const visits = yield* sandbox.exec("ls /home/daytona/work/visits | wc -l");
          return yield* HttpServerResponse.json({
            sandboxId: sandbox.sandboxId,
            visits: Number(visits.result.trim()),
          });
        }

        // DELETE /users/:user — remove the user: their sandbox and their volume.
        const removed = url.pathname.match(/^\/users\/([a-z0-9-]+)$/)?.[1];
        if (request.method === "DELETE" && removed) {
          yield* sandboxes.delete(`dev-${removed}`);
          const home = yield* volumes.get(`user-${removed}`);
          if (home === undefined) return HttpServerResponse.empty({ status: 204 });
          // Daytona releases the volume about a minute after its sandbox goes.
          return yield* volumes.delete(home.volumeId).pipe(
            Effect.as(HttpServerResponse.empty({ status: 204 })),
            Effect.catchTag("VolumeInUse", () =>
              Effect.succeed(
                HttpServerResponse.text("the volume is still in use; retry", {
                  status: 409,
                  headers: { "retry-after": "15" },
                }),
              ),
            ),
          );
        }

        // DELETE /users/:user/sandbox — delete the sandbox; the volume keeps the files.
        if (request.method === "DELETE" && user) {
          yield* sandboxes.delete(`dev-${user}`);
          return HttpServerResponse.empty({ status: 204 });
        }

        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(Effect.scoped, Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Daytona.CreateSandboxHttp, Daytona.CreateVolumeHttp))),
) {}
