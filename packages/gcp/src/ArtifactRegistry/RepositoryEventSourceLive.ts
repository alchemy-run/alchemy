import { adopt } from "alchemy/AdoptPolicy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Topic } from "../PubSub/Topic.ts";
import { TopicEventSource } from "../PubSub/TopicEventSource.ts";
import type { Repository } from "./Repository.ts";
import {
  RepositoryEventSource,
  toRepositoryEvent,
  type RepositoryEventsHandler,
  type RepositoryEventSourceProps,
  type RepositoryEventSourceService,
} from "./RepositoryEventSource.ts";

/**
 * Implementation of `GCP.ArtifactRegistry.RepositoryEventSource` over the
 * project's `gcr` Pub/Sub topic.
 *
 * Deploy-time: declares the `gcr` topic once per stack, adopting an
 * existing one and retaining it on destroy (it is shared project-wide).
 * Delivery is delegated to the provided `GCP.PubSub.TopicEventSource`
 * implementation. Runtime: notifications for other repositories, and
 * actions not requested, are acknowledged without reaching the handler.
 *
 * @layer
 * @provides GCP.ArtifactRegistry.RepositoryEventSource
 * @category ArtifactRegistry
 */
export const RepositoryEventSourceLive = Layer.effect(
  RepositoryEventSource,
  Effect.gen(function* () {
    const topics = yield* Topic;
    const source = yield* TopicEventSource;

    return Effect.fn(function* <Req = never>(
      repository: Repository,
      props: RepositoryEventSourceProps,
      handler: RepositoryEventsHandler<Req>,
    ) {
      const topic = yield* topics("ArtifactRegistryNotifications", { topicId: "gcr" }).pipe(
        adopt(),
        RemovalPolicy.retain(),
      );
      // Accessors for the repository's identity, read when messages arrive.
      const location = yield* repository.location;
      const project = yield* repository.project;
      const repositoryId = yield* repository.repositoryId;
      const prefix = Effect.map(
        Effect.all([location, project, repositoryId]),
        ([l, p, r]) => `${l}-docker.pkg.dev/${p}/${r}/`,
      );
      const actions = new Set(props.actions ?? ["INSERT", "DELETE"]);
      const { actions: _actions, ...delivery } = props;
      yield* source(topic, delivery, (messages) =>
        Effect.flatMap(prefix, (repositoryPrefix) =>
          handler(
            messages.pipe(
              Stream.map(toRepositoryEvent),
              Stream.filter(
                (event) =>
                  actions.has(event.action) &&
                  (event.digest ?? event.tag ?? "").startsWith(repositoryPrefix),
              ),
            ),
          ),
        ),
      );
    }) as RepositoryEventSourceService;
  }),
);
