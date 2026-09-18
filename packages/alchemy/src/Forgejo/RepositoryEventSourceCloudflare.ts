import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { isWorkerEvent, Worker } from "../Cloudflare/Workers/Worker.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Repository } from "./Repository.ts";
import {
  RepositoryEventSource,
  type RepositoryEventSourceProps,
  type RepositoryEvent,
} from "./RepositoryEventSource.ts";
import { makeForgejoSubscription } from "./RuntimeEvents.ts";

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
    return Effect.fn(function* (
      repo: Repository,
      props: RepositoryEventSourceProps,
      handler: (
        event: RepositoryEvent,
      ) => Effect.Effect<void, never, RuntimeContext>,
    ) {
      const subscription = yield* makeForgejoSubscription(
        `${host.Type}:${host.FQN}`,
        host.url,
        repo,
        props,
        host,
      );
      yield* host.listenFetch((event) => {
        if (!isWorkerEvent(event) || event.type !== "fetch") return;
        const request = event.input as unknown as Request;
        if (new URL(request.url).pathname !== subscription.path) return;
        return subscription.handle(request, handler);
      });
    });
  }),
);
