import * as pubsub from "@distilled.cloud/stackit/pubsub";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { type ProjectScope, readGeneration, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import {
  desiredGenerationLabels,
  hasAlchemyLabels,
  hasInstanceLabel,
  isAlchemyOwned,
  stripInternalLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  generatedDisplayName,
  getSubscriptionOrUndefined,
  labelsDelta,
  listProjectTopics,
  listTopicSubscriptions,
  onScope,
  PUBSUB_POLL,
  PUBSUB_TIMEOUT,
  retryWhileBusy,
  sameDuration,
  waitForTopicActive,
} from "./internal.ts";

/** Spec default of `subscriptionSettings.ackDeadline`. */
const DEFAULT_ACK_DEADLINE = "2m";

export interface SubscriptionProps {
  /** Id of the topic to subscribe to. Changing it replaces the subscription. */
  topicId: string;
  /**
   * Name of the subscription in the STACKIT portal, up to 36 letters, digits, spaces and
   * `-`. It isn't the subscription's identity, so changing it updates in place.
   *
   * If omitted, a name is generated from the stack, stage and logical ID.
   */
  displayName?: string;
  /**
   * Longer text describing the subscription, up to 1024 characters. Omit to leave the
   * live value alone.
   */
  description?: string;
  /**
   * How long a pulled message may stay unacknowledged before it is delivered again: a
   * number and `s`, `m` or `h`, from `1s` to `168h`. Omit to leave the live value alone.
   *
   * @default "2m"
   */
  ackDeadline?: string;
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`, `alchemy.stage`,
   * `alchemy.id`, `alchemy.instance`) are always merged in. Updates in place.
   */
  labels?: Record<string, string>;
  /**
   * Project that owns the topic. Defaults to the profile's project. Changing it replaces
   * the subscription.
   */
  projectId?: string;
  /**
   * Region of the topic. Defaults to the profile's region. Changing it replaces the
   * subscription.
   */
  region?: string;
}

export interface SubscriptionAttributes {
  /** STACKIT subscription id (UUID). Stable across updates. */
  subscriptionId: string;
  /** Id of the topic it subscribes to. */
  topicId: string;
  /** Project that owns the topic. */
  projectId: string;
  /** Region of the topic. */
  region: string;
  /** Name of the subscription in the STACKIT portal. */
  displayName: string;
  /** Description of the subscription, if any. */
  description: string | undefined;
  /** Subscription state; `active` after a deploy. */
  state: string;
  /** The subscription's settings, with the spec's default filled in. */
  settings: {
    /** How long a pulled message may stay unacknowledged. */
    ackDeadline: string;
  };
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
  /** When the subscription was created. */
  createTime: string;
}

export type Subscription = Resource<
  "Stackit.PubSub.Subscription",
  SubscriptionProps,
  SubscriptionAttributes,
  never,
  Providers
>;

/**
 * A STACKIT Pub/Sub subscription: one consumer's position on a `Stackit.PubSub.Topic`.
 * Messages are pulled, and delivered at least once: one that isn't acknowledged within
 * `ackDeadline` comes back. The API has no push delivery.
 *
 * Everything but the topic, project and region updates in place, because the
 * subscription's identity is a UUID the API assigns. Deploys wait until it is `active`,
 * and destroys until it is gone.
 *
 * Ownership is tracked with STACKIT labels. Without state, a subscription on the same topic
 * with the same explicit `displayName` that lacks them is reported as unowned, and only
 * taken over with `--adopt`.
 *
 * :::caution[Changing `topicId`, `projectId` or `region` replaces the Subscription]
 * Moving a subscription to another topic, project or region creates a new one and
 * deletes the old one with its unacknowledged messages. So does replacing its topic.
 * :::
 *
 * ### Creating a Subscription
 * **Example:** A subscription with a generated name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const topic = yield* Stackit.PubSub.Topic("Orders", {});
 * const subscription = yield* Stackit.PubSub.Subscription("Billing", {
 *   topicId: topic.topicId,
 * });
 * ```
 *
 * ### Configuring Redelivery
 * **Example:** Give a slow consumer ten minutes per message
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const topic = yield* Stackit.PubSub.Topic("Orders", {});
 * const subscription = yield* Stackit.PubSub.Subscription("Billing", {
 *   topicId: topic.topicId,
 *   displayName: "billing",
 *   description: "Invoices orders",
 *   ackDeadline: "10m",
 *   labels: { team: "finance" },
 * });
 * ```
 *
 * ### Pulling Messages
 * **Example:** Pull and acknowledge from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Layer from "effect/Layer";
 *
 * export const Orders = Stackit.PubSub.Topic("Orders", {});
 * export const Billing = Orders.pipe(
 *   Effect.flatMap((topic) =>
 *     Stackit.PubSub.Subscription("Billing", { topicId: topic.topicId }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const billing = yield* Billing;
 *     const pull = yield* Stackit.PubSub.Pull(billing);
 *     const acknowledge = yield* Stackit.PubSub.Acknowledge(billing);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { messages } = yield* pull({ maxMessages: 10 });
 *         if (messages.length > 0) {
 *           yield* acknowledge({ ackIds: messages.map((message) => message.ackId) });
 *         }
 *         return yield* HttpServerResponse.json(messages.map((message) => message.text));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(Stackit.PubSub.PullHttp, Stackit.PubSub.AcknowledgeHttp),
 *     ),
 *   ),
 * ) {}
 * ```
 *
 * ### Consuming in a Long-Lived Host
 * **Example:** A worker process
 * ```typescript
 * import * as Docker from "@alchemy.run/docker";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 *
 * export const Orders = Stackit.PubSub.Topic("Orders", {});
 * export const Billing = Orders.pipe(
 *   Effect.flatMap((topic) =>
 *     Stackit.PubSub.Subscription("Billing", { topicId: topic.topicId }),
 *   ),
 * );
 *
 * export default class BillingWorker extends Docker.Service<BillingWorker>()(
 *   "BillingWorker",
 *   { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     yield* Stackit.PubSub.consumeSubscriptionMessages(Billing, {}, (message) =>
 *       Effect.log(message.text),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(Stackit.PubSub.ServerSubscriptionEventSource)),
 * ) {}
 * ```
 *
 * @resource
 * @product STACKIT Pub/Sub
 * @category PubSub
 */
export const Subscription = Resource<Subscription>("Stackit.PubSub.Subscription");

const toAttrs = (
  scope: ProjectScope,
  topicId: string,
  subscription: pubsub.SubscriptionResponse,
): SubscriptionAttributes => ({
  subscriptionId: subscription.id,
  topicId,
  projectId: scope.projectId,
  region: scope.region,
  displayName: subscription.displayName,
  description: subscription.description === "" ? undefined : subscription.description,
  state: subscription.state,
  settings: { ackDeadline: subscription.settings?.ackDeadline ?? DEFAULT_ACK_DEADLINE },
  labels: stripInternalLabels(subscription.labels),
  createTime: subscription.createTime,
});

/** What a PATCH has to send: every drifted aspect, diffed against the observed subscription. */
const subscriptionDelta = (
  subscription: pubsub.SubscriptionResponse,
  props: SubscriptionProps,
  displayName: string,
  labels: Record<string, string>,
) => {
  const labelChange = labelsDelta(subscription.labels, labels);
  const observedDescription =
    subscription.description === "" ? undefined : subscription.description;
  return {
    ...(subscription.displayName !== displayName ? { displayName } : {}),
    ...(props.description !== undefined && observedDescription !== (props.description || undefined)
      ? { description: props.description }
      : {}),
    ...(props.ackDeadline !== undefined &&
    !sameDuration(subscription.settings?.ackDeadline ?? DEFAULT_ACK_DEADLINE, props.ackDeadline)
      ? { settings: { ackDeadline: props.ackDeadline } }
      : {}),
    ...(labelChange !== undefined ? { labels: labelChange } : {}),
  };
};

/** This generation's subscription: only that can be claimed without state. */
const findGeneration = (scope: ProjectScope, topicId: string, id: string, instanceId: string) =>
  Effect.gen(function* () {
    for (const subscription of yield* listTopicSubscriptions(scope, topicId)) {
      if (
        subscription.state !== "deleting" &&
        hasInstanceLabel(instanceId, subscription.labels) &&
        (yield* hasAlchemyLabels(id, subscription.labels))
      ) {
        return subscription;
      }
    }
    return undefined;
  });

const waitForSubscriptionGone = (scope: ProjectScope, topicId: string, subscriptionId: string) =>
  waitUntilGone({
    resource: `STACKIT Pub/Sub subscription ${subscriptionId}`,
    read: getSubscriptionOrUndefined(scope, topicId, subscriptionId),
    state: (subscription) => subscription.state,
    timeout: PUBSUB_TIMEOUT,
    ...PUBSUB_POLL,
  });

export const SubscriptionProvider = () =>
  Provider.succeed(Subscription, {
    stables: ["subscriptionId", "topicId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.PubSub.Topic"] },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const owned: SubscriptionAttributes[] = [];
      for (const topic of yield* listProjectTopics(scope)) {
        const subscriptions = yield* listTopicSubscriptions(scope, topic.id).pipe(
          // The topic may be deleted mid-listing.
          Effect.catchTag("NotFound", () => Effect.succeed([])),
        );
        for (const subscription of subscriptions) {
          if (isAlchemyOwned(subscription.labels)) {
            owned.push(toAttrs(scope, topic.id, subscription));
          }
        }
      }
      return owned;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An explicit name may have to be unique on its topic, which the spec doesn't say,
      // and an unresolved topic id can resolve to the topic it is already on: the old
      // subscription goes first.
      if (hasUnresolvedTrigger<SubscriptionProps>(news, ["topicId", "projectId", "region"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<SubscriptionProps>(news, "displayName") !== undefined,
        } as const;
      }
      const resolved = triggerProps<SubscriptionProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      if (
        resolved.topicId !== output.topicId ||
        scope.projectId !== output.projectId ||
        scope.region !== output.region
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const topicId = output?.topicId ?? olds?.topicId;
      if (topicId === undefined) return undefined;
      if (output?.subscriptionId !== undefined) {
        const byId = yield* getSubscriptionOrUndefined(scope, topicId, output.subscriptionId);
        if (byId !== undefined && byId.state !== "deleting") {
          return toAttrs(scope, topicId, byId);
        }
      }
      const subscriptions = (yield* listTopicSubscriptions(scope, topicId).pipe(
        // No topic, no subscription.
        Effect.catchTag("NotFound", () => Effect.succeed([])),
      )).filter((subscription) => subscription.state !== "deleting");
      // A crashed create has neither state nor a previous generation, and any generation
      // of this logical id is ours. A replacement only owns its own.
      const generation = readGeneration({ instanceId, output, previous });
      for (const subscription of subscriptions) {
        if (
          (yield* hasAlchemyLabels(id, subscription.labels)) &&
          (generation === undefined || hasInstanceLabel(generation, subscription.labels))
        ) {
          return toAttrs(scope, topicId, subscription);
        }
      }
      if (olds?.displayName === undefined) return undefined;
      // A display name found twice is evidently no identity, so it claims nothing.
      const named = subscriptions.filter(
        (subscription) => subscription.displayName === olds.displayName,
      );
      if (named.length !== 1) return undefined;
      const attrs = toAttrs(scope, topicId, named[0]!);
      const isPrevious =
        previous?.subscriptionId === attrs.subscriptionId &&
        previous.topicId === topicId &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const topicId = news.topicId;
      const displayName =
        news.displayName ?? output?.displayName ?? (yield* generatedDisplayName(id));
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);
      const resource = `STACKIT Pub/Sub subscription ${displayName}`;

      // 1. Observe — `output` is a cache for the id, and only names the desired
      // subscription while it sits on the same topic. Without it, only this generation's
      // subscription can be claimed.
      let current: pubsub.SubscriptionResponse | undefined =
        output?.subscriptionId !== undefined &&
        output.topicId === topicId &&
        output.projectId === scope.projectId &&
        output.region === scope.region
          ? yield* getSubscriptionOrUndefined(scope, topicId, output.subscriptionId)
          : undefined;
      current ??= yield* findGeneration(scope, topicId, id, instanceId);
      // A delete in flight (an interrupted destroy): let it finish.
      if (current?.state === "deleting") {
        yield* waitForSubscriptionGone(scope, topicId, current.id);
        current = undefined;
      }

      // 2. Ensure — a 409 may be our own create racing, so look again before failing.
      if (current === undefined) {
        // A grant can leave the topic `reconciling`.
        yield* waitForTopicActive(scope, topicId);
        current = yield* retryWhileBusy(
          pubsub
            .createSubscription({
              ...onScope(scope),
              topicId,
              displayName,
              ...(news.description !== undefined ? { description: news.description } : {}),
              labels,
              ...(news.ackDeadline !== undefined
                ? { settings: { ackDeadline: news.ackDeadline } }
                : {}),
            })
            .pipe(
              Effect.catchTag("Conflict", (error) =>
                findGeneration(scope, topicId, id, instanceId).pipe(
                  Effect.flatMap((found) =>
                    found === undefined ? Effect.fail(error) : Effect.succeed(found),
                  ),
                ),
              ),
            ),
        );
      }
      const subscriptionId = current.id;

      const settle = (applied: (subscription: pubsub.SubscriptionResponse) => boolean) =>
        waitFor({
          resource,
          // A subscription just created can take a moment to be readable.
          read: getSubscriptionOrUndefined(scope, topicId, subscriptionId),
          ready: (subscription) => subscription?.state === "active" && applied(subscription),
          state: (subscription) => subscription?.state ?? "not visible yet",
          timeout: PUBSUB_TIMEOUT,
          ...PUBSUB_POLL,
        });
      current = (yield* settle(() => true))!;

      // 3. Sync — one PATCH with every drifted aspect. Waiting for the new values too
      // means a read from before the PATCH can't pass. Labels aren't awaited: whether a
      // PATCH replaces or merges the map is undocumented, and that must not stall a deploy.
      const delta = subscriptionDelta(current, news, displayName, labels);
      if (Object.keys(delta).length > 0) {
        yield* retryWhileBusy(
          pubsub.updateSubscription({ ...onScope(scope), topicId, subscriptionId, ...delta }),
        );
        current = (yield* settle((subscription) => {
          const { labels: _labels, ...rest } = subscriptionDelta(
            subscription,
            news,
            displayName,
            labels,
          );
          return Object.keys(rest).length === 0;
        }))!;
      }

      // 4. Return
      return toAttrs(scope, topicId, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const { topicId, subscriptionId } = output;
      const current = yield* getSubscriptionOrUndefined(scope, topicId, subscriptionId);
      if (current === undefined) return;
      if (current.state !== "deleting") {
        yield* retryWhileBusy(
          pubsub.deleteSubscription({ ...onScope(scope), topicId, subscriptionId }),
        ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
      yield* waitForSubscriptionGone(scope, topicId, subscriptionId);
    }),
  });
