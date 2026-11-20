import * as Binding from "alchemy/Binding";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Member } from "../IAM/Member.ts";
import { Topic } from "../PubSub/Topic.ts";
import { TopicEventSource } from "../PubSub/TopicEventSource.ts";
import {
  AuditLogEventSource,
  toAuditLogEvent,
  type AuditLogEvent,
  type AuditLogEventSourceProps,
  type AuditLogEventSourceService,
} from "./AuditLogEventSource.ts";
import { Sink } from "./Sink.ts";

/**
 * Implementation of `GCP.Logging.AuditLogEventSource` over a Logging sink
 * and Pub/Sub.
 *
 * Deploy-time: creates a Pub/Sub topic owned by the host
 * (`{id}-AuditLogs`), a project Logging sink with its own writer identity
 * that routes entries matching the filter to the topic, and grants that
 * identity `roles/pubsub.publisher` on the topic. Delivery is delegated to
 * the provided `GCP.PubSub.TopicEventSource` implementation:
 * `GCP.Run.TopicEventSource` (push, HTTP hosts) or
 * `GCP.Run.TopicPullEventSource` (pull, Jobs and WorkerPools). Runtime:
 * each message is parsed into an `AuditLogEvent`.
 *
 * ### Choosing the delivery
 * **Example:** Push to a Cloud Run service
 * ```typescript
 * Effect.gen(function* () {
 *   yield* GCP.SecretManager.consumeSecretAuditLogs(secret, (events) =>
 *     events.pipe(Stream.runForEach((event) => Effect.log(event.methodName))),
 *   );
 * }).pipe(
 *   Effect.provide(GCP.Logging.AuditLogEventSourceLive),
 *   Effect.provide(GCP.Run.TopicEventSource),
 * );
 * ```
 *
 * @layer
 * @provides GCP.Logging.AuditLogEventSource
 * @category Logging
 */
export const AuditLogEventSourceLive = Layer.effect(
  AuditLogEventSource,
  Effect.gen(function* () {
    const topics = yield* Topic;
    const sinks = yield* Sink;
    const members = yield* Member;
    const source = yield* TopicEventSource;

    return Effect.fn(function* <Req = never>(
      id: string,
      props: AuditLogEventSourceProps,
      handler: (events: Stream.Stream<AuditLogEvent>) => Effect.Effect<void, never, Req>,
    ) {
      const host = yield* Binding.Host;
      const hostId = host?.LogicalId ?? "Host";
      // Declared in both phases: the delivery implementation declares its
      // subscription against this topic at runtime too.
      const topic = yield* Namespace.push(hostId, topics(`${id}-AuditLogs`, {}));

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const sink = yield* Namespace.push(
          hostId,
          sinks(`${id}-AuditLogSink`, {
            destination: Output.interpolate`pubsub.googleapis.com/${topic.name}`,
            filter: props.filter,
            uniqueWriterIdentity: true,
          }),
        );
        yield* Namespace.push(
          hostId,
          members(`${id}-AuditLogPublisher`, {
            kind: "pubsub.topic",
            name: topic.name,
            role: "roles/pubsub.publisher",
            member: Output.map(sink.writerIdentity, (identity) => identity!),
          }),
        );
      }

      const { filter: _filter, ...delivery } = props;
      yield* source(topic, delivery, (messages) =>
        handler(messages.pipe(Stream.mapEffect(toAuditLogEvent))),
      );
    }) as AuditLogEventSourceService;
  }),
);
