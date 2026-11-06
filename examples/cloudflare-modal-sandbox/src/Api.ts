// src/Api.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Agents, Warm } from "./Sandbox.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const sandboxes = yield* Modal.CreateSandbox(Warm);
    const volumes = yield* Modal.CreateVolume(Agents);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        const user = url.searchParams.get("user") ?? "anonymous";

        if (url.pathname === "/notes") {
          const home = yield* volumes.getOrCreate(`home-${user}`);
          if (request.method === "PUT") {
            yield* home.writeFile("/notes.txt", yield* request.text);
          }
          const notes = yield* home
            .readFileString("/notes.txt")
            .pipe(Effect.catchTag("VolumeFileNotFound", () => Effect.succeed("")));
          return HttpServerResponse.text(notes);
        }

        if (url.pathname === "/run") {
          const home = yield* volumes.getOrCreate(`home-${user}`);
          const sandbox = yield* sandboxes.create({
            mounts: [{ volume: home, path: "/home/user" }],
            timeout: "5 minutes",
          });
          const result = yield* sandbox
            .exec("ls /work && cat /home/user/notes.txt")
            .pipe(Effect.ensuring(Effect.ignore(sandbox.terminate())));
          return yield* HttpServerResponse.json(result);
        }

        return HttpServerResponse.text("PUT /notes?user=…, GET /notes?user=…, GET /run?user=…");
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Modal.CreateSandboxHttp, Modal.CreateVolumeHttp))),
) {}
