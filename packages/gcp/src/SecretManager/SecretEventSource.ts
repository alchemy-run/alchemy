import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { TopicEventSourceProps, TopicMessage } from "../PubSub/TopicEventSource.ts";
import type { Secret } from "./Secret.ts";

/** Secret Manager notification event types. */
export type SecretEventType =
  | "SECRET_CREATE"
  | "SECRET_UPDATE"
  | "SECRET_DELETE"
  | "SECRET_VERSION_ADD"
  | "SECRET_VERSION_ENABLE"
  | "SECRET_VERSION_DISABLE"
  | "SECRET_VERSION_DESTROY"
  | "SECRET_VERSION_DESTROY_SCHEDULED"
  | "SECRET_ROTATE"
  | "TOPIC_CONFIGURED";

/** One Secret Manager notification. */
export interface SecretEvent {
  /** What happened. */
  eventType: SecretEventType;
  /** Full name of the secret, `projects/p/secrets/s`. */
  secret: string;
  /** Full name of the version, for `SECRET_VERSION_*` events. */
  version: string | undefined;
  /** RFC3339 publish time of the notification. */
  publishTime: string;
  /**
   * The secret or version resource at the time of the event (the
   * notification's JSON payload; never the secret's data).
   */
  resource: Record<string, unknown>;
}

export interface SecretEventSourceProps extends Omit<TopicEventSourceProps, "filter"> {
  /**
   * Event types to deliver; the subscription filters out the rest.
   * Every type when omitted.
   */
  eventTypes?: SecretEventType[];
}

export type SecretEventsHandler<Req> = (
  events: Stream.Stream<SecretEvent>,
) => Effect.Effect<void, never, Req>;

export type SecretEventSourceService = <Req = never>(
  secret: Secret,
  props: SecretEventSourceProps,
  process: SecretEventsHandler<Req>,
) => Effect.Effect<void, never, never>;

/**
 * Event source streaming a Secret Manager {@link Secret}'s notifications —
 * versions added, enabled, disabled or destroyed, the secret updated or
 * deleted, rotation due — into the hosting compute.
 *
 * `GCP.SecretManager.SecretEventSourceLive` provisions a Pub/Sub topic
 * owned by the host and binds it onto the secret's notification `topics`
 * (the Secret provider grants the Secret Manager service agent
 * `roles/pubsub.publisher` on it), then delegates delivery to the provided
 * `GCP.PubSub.TopicEventSource` implementation:
 * `GCP.Run.TopicEventSource` (push) or `GCP.Run.TopicPullEventSource`
 * (pull).
 *
 * Consume it through {@link consumeSecretEvents}.
 *
 * ### Consuming secret events
 * **Example:** React to new versions
 * ```typescript
 * yield* GCP.SecretManager.consumeSecretEvents(
 *   apiKey,
 *   { eventTypes: ["SECRET_VERSION_ADD"] },
 *   (events) =>
 *     events.pipe(Stream.runForEach((event) => Effect.log(`new version ${event.version}`))),
 * );
 * // …provided with GCP.SecretManager.SecretEventSourceLive and GCP.Run.TopicEventSource
 * ```
 *
 * **Example:** Rotate on schedule
 * ```typescript
 * const apiKey = yield* GCP.SecretManager.Secret("ApiKey", {
 *   rotation: { rotationPeriod: "2592000s", nextRotationTime: "2026-12-01T00:00:00Z" },
 * });
 * yield* GCP.SecretManager.consumeSecretEvents(
 *   apiKey,
 *   { eventTypes: ["SECRET_ROTATE"] },
 *   (events) => events.pipe(Stream.runForEach(() => rotate)),
 * );
 * ```
 *
 * @binding
 * @category SecretManager
 */
export interface SecretEventSource extends Binding.Service<
  SecretEventSource,
  "GCP.SecretManager.SecretEventSource",
  SecretEventSourceService
> {}

export const SecretEventSource = Binding.Service<SecretEventSource>(
  "GCP.SecretManager.SecretEventSource",
);

/**
 * Subscribe an Effect handler to a {@link Secret}'s notifications. See
 * {@link SecretEventSource} for the implementations.
 */
export function consumeSecretEvents<Req = never, ResourceReq = never>(
  secret: Secret | Effect.Effect<Secret, never, ResourceReq>,
  process: SecretEventsHandler<Req>,
): Effect.Effect<void, never, SecretEventSource | ResourceReq>;
export function consumeSecretEvents<Req = never, ResourceReq = never>(
  secret: Secret | Effect.Effect<Secret, never, ResourceReq>,
  props: SecretEventSourceProps,
  process: SecretEventsHandler<Req>,
): Effect.Effect<void, never, SecretEventSource | ResourceReq>;
export function consumeSecretEvents<Req = never, ResourceReq = never>(
  secret: Secret | Effect.Effect<Secret, never, ResourceReq>,
  propsOrProcess: SecretEventSourceProps | SecretEventsHandler<Req>,
  maybeProcess?: SecretEventsHandler<Req>,
): Effect.Effect<void, never, SecretEventSource | ResourceReq> {
  const [props, process] =
    typeof propsOrProcess === "function"
      ? [{} as SecretEventSourceProps, propsOrProcess]
      : [propsOrProcess, maybeProcess!];
  const resolved = Effect.isEffect(secret) ? secret : Effect.succeed(secret);
  return resolved.pipe(
    Effect.flatMap((value) => SecretEventSource.use((source) => source(value, props, process))),
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

/** Parse a Secret Manager notification into a {@link SecretEvent}. */
export const toSecretEvent = ({ message }: TopicMessage) =>
  Effect.sync((): SecretEvent => {
    const attributes = message.attributes ?? {};
    let resource: Record<string, unknown> = {};
    try {
      if (message.data) resource = JSON.parse(decodeBase64Utf8(message.data));
    } catch {
      resource = {};
    }
    return {
      eventType: (attributes.eventType ?? "") as SecretEventType,
      secret: attributes.secretId ?? "",
      version: attributes.versionId,
      publishTime: message.publishTime ?? "",
      resource,
    };
  });
