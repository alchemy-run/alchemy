// src/Api.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { MyEnv, Warm } from "./Sandbox.ts";

/**
 * Starts sandboxes from the Warm image while it runs. Each user has a volume
 * of their own: their files live on it, and every sandbox they run mounts it
 * at /home/user and leaves its output there.
 */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const sandboxes = yield* Modal.CreateSandbox(Warm);
    const volumes = yield* Modal.CreateVolume(MyEnv);

    /**
     * Runs a command in the repository, in a fresh sandbox from Warm with the
     * user's volume mounted. A Worker can't stream a sandbox's output yet, so
     * the command writes it to the volume and the Worker reads it back.
     */
    const run = Effect.fn("run")(function* (user: string, command: string) {
      const home = yield* volumes.getOrCreate(`home-${user}`);
      const sandbox = yield* sandboxes.create({
        command: ["sh", "-c", `cd /work && { ${command}; } > /home/user/.output 2>&1`],
        mounts: [{ volume: home, path: "/home/user" }],
        timeout: "5 minutes",
      });
      const { exitCode } = yield* sandbox.wait("50 seconds");
      return { exitCode, output: yield* home.readFileString("/.output") };
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");

        const runFor = /^\/users\/([a-z0-9-]+)\/run$/.exec(url.pathname)?.[1];
        if (request.method === "POST" && runFor !== undefined) {
          return yield* HttpServerResponse.json(yield* run(runFor, yield* request.text));
        }

        const user = /^\/users\/([a-z0-9-]+)$/.exec(url.pathname)?.[1];
        if (request.method === "DELETE" && user !== undefined) {
          yield* volumes.delete(`home-${user}`);
          return HttpServerResponse.empty({ status: 204 });
        }

        const match = /^\/users\/([a-z0-9-]+)\/files\/(.+)$/.exec(url.pathname);
        if (match !== null) {
          const [, owner, file] = match as unknown as [string, string, string];
          const home = yield* volumes.getOrCreate(`home-${owner}`);
          if (request.method === "PUT") yield* home.writeFile(`/${file}`, yield* request.text);
          return yield* HttpServerResponse.json({
            content: yield* home.readFileString(`/${file}`),
          });
        }

        if (url.pathname === "/") return HttpServerResponse.text("ok");
        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Modal.CreateSandboxHttp, Modal.CreateVolumeHttp))),
) {}
