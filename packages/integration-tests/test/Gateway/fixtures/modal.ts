import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schedule from "effect/Schedule";
import { app, WorkerGateway } from "../conformance/app.ts";

export const GatewayEnv = Modal.Environment("GatewayEnv", {});
export const GatewayApp = Modal.App("GatewayApp", { environment: GatewayEnv });

/** The conformance program in a Modal sandbox. */
export class GatewayedModal extends Modal.Sandbox<GatewayedModal>()(
  "GatewayedModal",
  { main: import.meta.url, handler: "GatewayedModal", app: GatewayApp },
  app.pipe(Effect.provide(WorkerGateway)),
) {}

/** Starts a sandbox of the program per request and returns its answer. */
export default class ModalHost extends Cloudflare.Worker<ModalHost>()(
  "GatewayModalHost",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sandboxes = yield* Modal.CreateSandbox(GatewayedModal);
    return {
      fetch: Effect.gen(function* () {
        const sandbox = yield* sandboxes.create({ timeout: "5 minutes" });
        const body = yield* Effect.gen(function* () {
          const port = yield* sandbox.getTcpPort();
          const response = yield* port
            .fetch(HttpClientRequest.get("/"))
            // The program needs a few seconds to start listening after boot.
            .pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 20 }));
          return { status: response.status, text: yield* response.text };
        }).pipe(Effect.ensuring(Effect.ignore(sandbox.terminate())));
        return HttpServerResponse.text(body.text, {
          status: body.status,
          headers: { "content-type": "application/json" },
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Modal.CreateSandboxHttp)),
) {}
