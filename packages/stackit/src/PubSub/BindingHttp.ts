import * as pubsubData from "@distilled.cloud/stackit/pubsub_data";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as Result from "effect/Result";
import * as StackitBindings from "../StackitBindings.ts";
import type { PublishRequest } from "./Publish.ts";
import type { PulledMessage, PullRequest, PullResponse, UndecodableMessage } from "./Pull.ts";
import type { Subscription } from "./Subscription.ts";
import { SubscriptionSubscriberAccess } from "./SubscriptionSubscriberAccess.ts";
import type { Topic } from "./Topic.ts";
import { TopicPublisherAccess } from "./TopicPublisherAccess.ts";

/**
 * Shared HTTP scaffolding for Pub/Sub bindings.
 * NOT exported from index.ts.
 *
 * Management bindings grant a custom role with the permission the spec names for the
 * operation (`x-stackit-authorization`), on the project holding the topic, because
 * STACKIT has no role binding on anything narrower (see `StackitBindings`). The role is
 * shared per permission set.
 *
 * Data-plane bindings (publish, purge, pull, acknowledge) have no permission in their
 * spec. They add the host's service account to the resource's own access list instead,
 * which is narrower: one topic or one subscription.
 */

/** Build a binding over one operation on a topic's project, which it only supplies. */
export const makeProjectHttpBinding = <
  I extends { projectId: string; regionId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.PubSub.ListTopics`. */
  tag: string;
  /** The exact permissions the operation needs. */
  permissions: readonly string[];
  /** The distilled operation; the topic's project and region are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (topic: Topic) => ({ projectId: topic.projectId, regionId: topic.region }),
    grants: (topic) => [StackitBindings.grantOn(topic, { permissions: options.permissions })],
  });

/** Build a binding over one management operation on a topic. */
export const makeTopicHttpBinding = <
  I extends { projectId: string; regionId: string; topicId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.PubSub.GetTopic`. */
  tag: string;
  /** The exact permissions the operation needs. */
  permissions: readonly string[];
  /** The distilled operation; the topic's project, region and id are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (topic: Topic) => ({
      projectId: topic.projectId,
      regionId: topic.region,
      topicId: topic.topicId,
    }),
    grants: (topic) => [StackitBindings.grantOn(topic, { permissions: options.permissions })],
  });

/** Build a binding over one management operation on a subscription. */
export const makeSubscriptionHttpBinding = <
  I extends { projectId: string; regionId: string; topicId: string; subscriptionId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.PubSub.GetSubscription`. */
  tag: string;
  /** The exact permissions the operation needs. */
  permissions: readonly string[];
  /** The distilled operation; the subscription's project, region and ids are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (subscription: Subscription) => ({
      projectId: subscription.projectId,
      regionId: subscription.region,
      topicId: subscription.topicId,
      subscriptionId: subscription.subscriptionId,
    }),
    grants: (subscription) => [
      StackitBindings.grantOn(subscription, { permissions: options.permissions }),
    ],
  });

/**
 * Add the host's service account to a topic's publishers. Yield it while the layer is
 * built, and call it behind the `__ALCHEMY_RUNTIME__` guard. Bindings on one topic and
 * host share one grant, so removing one of them can't revoke the other's access.
 */
const GrantPublisher: Effect.Effect<(topic: Topic) => Effect.Effect<void>> = Effect.gen(
  function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return () => Effect.void;
    const Access = yield* TopicPublisherAccess;
    const hostAccount = yield* StackitBindings.HostServiceAccount;
    return Effect.fn(function* (topic: Topic) {
      const host = yield* Binding.Host;
      const account = yield* hostAccount;
      if (host === undefined || account === undefined) return;
      yield* Access(`${host.LogicalId}${topic.LogicalId}Publisher`, {
        topicId: topic.topicId,
        emailAddress: account.email,
        projectId: topic.projectId,
        region: topic.region,
      });
    });
  },
);

/**
 * Add the host's service account to a subscription's subscribers. Yield it while the
 * layer is built, and call it behind the `__ALCHEMY_RUNTIME__` guard. Bindings on one
 * subscription and host share one grant.
 */
const GrantSubscriber: Effect.Effect<(subscription: Subscription) => Effect.Effect<void>> =
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return () => Effect.void;
    const Access = yield* SubscriptionSubscriberAccess;
    const hostAccount = yield* StackitBindings.HostServiceAccount;
    return Effect.fn(function* (subscription: Subscription) {
      const host = yield* Binding.Host;
      const account = yield* hostAccount;
      if (host === undefined || account === undefined) return;
      yield* Access(`${host.LogicalId}${subscription.LogicalId}Subscriber`, {
        topicId: subscription.topicId,
        subscriptionId: subscription.subscriptionId,
        emailAddress: account.email,
        projectId: subscription.projectId,
        region: subscription.region,
      });
    });
  });

/**
 * Attach a subscriber to its host: the created key and the place on the subscriber list.
 * Yield it while the layer is built, and call it behind the `__ALCHEMY_RUNTIME__` guard.
 */
export const BindSubscriber: Effect.Effect<
  (tag: string, subscription: Subscription) => Effect.Effect<void>
> = Effect.gen(function* () {
  const bind = yield* StackitBindings.Bind;
  const grant = yield* GrantSubscriber;
  return Effect.fn(function* (tag: string, subscription: Subscription) {
    yield* bind`${tag}(${subscription})`({});
    yield* grant(subscription);
  });
});

/** Build a binding over one data-plane operation on a topic. */
export const makeTopicDataHttpBinding = <
  I extends { topicId: string; regionId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.PubSub.Publish`. */
  tag: string;
  /** The distilled operation; the topic's id and region are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* StackitBindings.Bind;
    const grant = yield* GrantPublisher;
    const run = yield* StackitBindings.withCredentials(options.operation);
    return Effect.fn(function* (topic: Topic) {
      const topicId = yield* topic.topicId;
      const regionId = yield* topic.region;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${topic})`({});
        yield* grant(topic);
      }
      return Effect.fn(`${options.tag}(${topic.LogicalId})`)(function* (
        request?: Omit<I, "topicId" | "regionId">,
      ) {
        const place = { topicId: yield* topicId, regionId: yield* regionId };
        // The compiler can't prove `Omit<I, K>` plus the `K` fields is `I`.
        return yield* run({ ...request, ...place } as unknown as I);
      });
    });
  });

/** Build a binding over one data-plane operation on a subscription. */
export const makeSubscriptionDataHttpBinding = <
  I extends { topicId: string; regionId: string; subscriptionId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.PubSub.Pull`. */
  tag: string;
  /** The distilled operation; the subscription's ids and region are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bindSubscriber = yield* BindSubscriber;
    const run = yield* StackitBindings.withCredentials(options.operation);
    return Effect.fn(function* (subscription: Subscription) {
      const topicId = yield* subscription.topicId;
      const regionId = yield* subscription.region;
      const subscriptionId = yield* subscription.subscriptionId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bindSubscriber(options.tag, subscription);
      }
      return Effect.fn(`${options.tag}(${subscription.LogicalId})`)(function* (
        request?: Omit<I, "topicId" | "regionId" | "subscriptionId">,
      ) {
        const place = {
          topicId: yield* topicId,
          regionId: yield* regionId,
          subscriptionId: yield* subscriptionId,
        };
        // The compiler can't prove `Omit<I, K>` plus the `K` fields is `I`.
        return yield* run({ ...request, ...place } as unknown as I);
      });
    });
  });

/** {@link pubsubData.publishMessages} that takes text or bytes: `data` is base64 on the wire. */
export const publishOperation = /*@__PURE__*/ Effect.map(
  pubsubData.publishMessages,
  (publish) => (request: PublishRequest & { topicId: string; regionId: string }) =>
    publish({
      topicId: request.topicId,
      regionId: request.regionId,
      messages: request.messages.map((message) => ({ data: Base64.encode(message.data) })),
    }),
);

const decodeMessage = (
  message: pubsubData.Message,
): Result.Result<PulledMessage, UndecodableMessage> => {
  const decoded = Base64.decode(message.data);
  return Result.isSuccess(decoded)
    ? Result.succeed({
        ackId: message.ackId,
        data: decoded.success,
        text: new TextDecoder().decode(decoded.success),
        createTime: message.createTime,
        deliveryAttempts: message.deliveryAttempts,
      })
    : Result.fail({
        ackId: message.ackId,
        deliveryAttempts: message.deliveryAttempts,
        reason: "its data isn't base64",
      });
};

/** {@link pubsubData.pullMessages} with readable options and decoded messages. */
export const pullOperation = /*@__PURE__*/ Effect.map(
  pubsubData.pullMessages,
  (pull) =>
    (request: PullRequest & { topicId: string; regionId: string; subscriptionId: string }) =>
      pull({
        topicId: request.topicId,
        regionId: request.regionId,
        subscriptionId: request.subscriptionId,
        ...(request.maxMessages !== undefined ? { pubSubMaxMessages: request.maxMessages } : {}),
        ...(request.longPullDuration !== undefined
          ? { pubSubLongPullDuration: request.longPullDuration }
          : {}),
      }).pipe(
        // One bad message mustn't cost the batch: the others' ack ids would be lost with it.
        Effect.map(({ messages }): PullResponse => {
          const decoded: PulledMessage[] = [];
          const undecodable: UndecodableMessage[] = [];
          for (const message of messages) {
            const result = decodeMessage(message);
            if (Result.isSuccess(result)) decoded.push(result.success);
            else undecodable.push(result.failure);
          }
          return { messages: decoded, undecodable };
        }),
      ),
);
