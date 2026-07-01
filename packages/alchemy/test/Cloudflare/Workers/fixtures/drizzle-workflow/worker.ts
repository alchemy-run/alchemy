import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import DrizzleWorkflow from "./workflow.ts";

/**
 * Worker that hosts {@link DrizzleWorkflow} and exposes start/status routes so
 * the test can fire an instance and poll it to completion. The Hyperdrive
 * binding is declared inside the workflow (not here) and propagates onto this
 * worker's deployment config, mirroring how a Durable Object declares its own
 * bindings.
 */
export default class DrizzleWorkflowWorker extends Cloudflare.Worker<DrizzleWorkflowWorker>()(
  "DrizzleWorkflowWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const workflow = yield* DrizzleWorkflow;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        if (request.url.startsWith("/workflow/start/")) {
          const id = Number(request.url.split("/workflow/start/")[1] ?? "1");
          const instance = yield* workflow.create({ id, name: `widget-${id}` });
          return yield* HttpServerResponse.json({ instanceId: instance.id });
        }

        if (request.url.startsWith("/workflow/status/")) {
          const instanceId = request.url.split("/workflow/status/")[1] ?? "";
          const instance = yield* workflow.get(instanceId);
          const status = yield* instance.status();
          return yield* HttpServerResponse.json(status);
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }),
) {}
