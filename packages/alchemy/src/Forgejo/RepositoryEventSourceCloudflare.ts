import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { isWorkerEvent, Worker } from "../Cloudflare/Workers/Worker.ts";
import { RepositoryEventSource } from "./RepositoryEventSource.ts";
import { makeForgejoEventSource } from "./RuntimeEvents.ts";

/**
 * Receives signed Forgejo webhooks through a Cloudflare Worker's fetch handler.
 *
 * @layer
 * @provides Forgejo.RepositoryEventSource
 */
export const RepositoryEventSourceCloudflare = Layer.effect(
  RepositoryEventSource,
  Effect.gen(function* () {
    const host = yield* Worker;
    return yield* makeForgejoEventSource({
      host: `${host.Type}:${host.FQN}`,
      url: host.url,
      runtime: host,
      listen: (receiver) =>
        host.listen((event) => {
          if (!isWorkerEvent(event) || event.type !== "fetch") return;
          const request = event.input as unknown as Request;
          if (new URL(request.url).pathname !== receiver.path) return;
          return receiver.handle(request);
        }),
    });
  }),
);
