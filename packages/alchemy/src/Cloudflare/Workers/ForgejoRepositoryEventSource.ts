import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Repository } from "../../Forgejo/Repository.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import {
  RepositoryEventSource,
  type RepositoryEventSourceProps,
  type RepositoryEvent,
} from "../../Forgejo/RepositoryEventSource.ts";
import { makeForgejoSubscription } from "../../Forgejo/RuntimeEvents.ts";
import { isWorkerEvent, Worker } from "./Worker.ts";

/** Cloudflare fetch listener for mandatory signed Forgejo repository events. */
export const ForgejoRepositoryEventSourceLive = Layer.effect(
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
