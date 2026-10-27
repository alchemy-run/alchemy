import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { TopicEventSourceProps, TopicMessage } from "../PubSub/TopicEventSource.ts";
import type { Repository } from "./Repository.ts";

/** One Docker image change in a repository. */
export interface RepositoryEvent {
  /** `INSERT` when an image or tag is pushed, `DELETE` when one is removed. */
  action: "INSERT" | "DELETE";
  /** Image by digest, e.g. `us-central1-docker.pkg.dev/p/repo/app@sha256:…`. */
  digest: string | undefined;
  /** Image by tag, e.g. `us-central1-docker.pkg.dev/p/repo/app:latest`, when tagged. */
  tag: string | undefined;
  /** RFC3339 publish time of the notification. */
  publishTime: string;
}

export interface RepositoryEventSourceProps extends Omit<TopicEventSourceProps, "filter"> {
  /**
   * Actions to deliver.
   * @default ["INSERT", "DELETE"]
   */
  actions?: RepositoryEvent["action"][];
}

export type RepositoryEventsHandler<Req> = (
  events: Stream.Stream<RepositoryEvent>,
) => Effect.Effect<void, never, Req>;

export type RepositoryEventSourceService = <Req = never>(
  repository: Repository,
  props: RepositoryEventSourceProps,
  process: RepositoryEventsHandler<Req>,
) => Effect.Effect<void, never, never>;

/**
 * Event source streaming image pushes and deletions in a Docker-format
 * Artifact Registry {@link Repository} into the hosting compute.
 *
 * Artifact Registry publishes every Docker change in a project to one
 * Pub/Sub topic that must be named `gcr`.
 * `GCP.ArtifactRegistry.RepositoryEventSourceLive` declares that topic
 * (adopting it when it exists, and keeping it on destroy, since other
 * stacks share it), subscribes the host to it through the provided
 * `GCP.PubSub.TopicEventSource` implementation, and delivers only the
 * events for the bound repository.
 *
 * Consume it through {@link consumeRepositoryEvents}.
 *
 * ### Consuming image pushes
 * **Example:** Deploy on push
 * ```typescript
 * yield* GCP.ArtifactRegistry.consumeRepositoryEvents(
 *   images,
 *   { actions: ["INSERT"] },
 *   (events) => events.pipe(Stream.runForEach((event) => Effect.log(`pushed ${event.tag}`))),
 * );
 * // …provided with GCP.ArtifactRegistry.RepositoryEventSourceLive and GCP.Run.TopicEventSource
 * ```
 *
 * @binding
 * @category ArtifactRegistry
 */
export interface RepositoryEventSource extends Binding.Service<
  RepositoryEventSource,
  "GCP.ArtifactRegistry.RepositoryEventSource",
  RepositoryEventSourceService
> {}

export const RepositoryEventSource = Binding.Service<RepositoryEventSource>(
  "GCP.ArtifactRegistry.RepositoryEventSource",
);

/**
 * Subscribe an Effect handler to a Docker {@link Repository}'s image
 * changes. See {@link RepositoryEventSource}.
 */
export function consumeRepositoryEvents<Req = never, ResourceReq = never>(
  repository: Repository | Effect.Effect<Repository, never, ResourceReq>,
  process: RepositoryEventsHandler<Req>,
): Effect.Effect<void, never, RepositoryEventSource | ResourceReq>;
export function consumeRepositoryEvents<Req = never, ResourceReq = never>(
  repository: Repository | Effect.Effect<Repository, never, ResourceReq>,
  props: RepositoryEventSourceProps,
  process: RepositoryEventsHandler<Req>,
): Effect.Effect<void, never, RepositoryEventSource | ResourceReq>;
export function consumeRepositoryEvents<Req = never, ResourceReq = never>(
  repository: Repository | Effect.Effect<Repository, never, ResourceReq>,
  propsOrProcess: RepositoryEventSourceProps | RepositoryEventsHandler<Req>,
  maybeProcess?: RepositoryEventsHandler<Req>,
): Effect.Effect<void, never, RepositoryEventSource | ResourceReq> {
  const [props, process] =
    typeof propsOrProcess === "function"
      ? [{} as RepositoryEventSourceProps, propsOrProcess]
      : [propsOrProcess, maybeProcess!];
  const resolved = Effect.isEffect(repository) ? repository : Effect.succeed(repository);
  return resolved.pipe(
    Effect.flatMap((value) => RepositoryEventSource.use((source) => source(value, props, process))),
  );
}

const decodeBase64Utf8 = (data: string) => {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
};

/** Parse a `gcr` topic notification into a {@link RepositoryEvent}. */
export const toRepositoryEvent = ({ message }: TopicMessage): RepositoryEvent => {
  let data: { action?: string; digest?: string; tag?: string } = {};
  try {
    if (message.data) data = JSON.parse(decodeBase64Utf8(message.data));
  } catch {
    data = {};
  }
  return {
    action: data.action === "DELETE" ? "DELETE" : "INSERT",
    digest: data.digest,
    tag: data.tag,
    publishTime: message.publishTime ?? "",
  };
};
