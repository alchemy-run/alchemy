import * as pubsub from "@distilled.cloud/stackit/pubsub";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { type ProjectScope, readGeneration, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { sameMembers } from "../internal/equal.ts";
import { childrenLeftAfterSettling, waitFor, waitUntilGone } from "../internal/wait.ts";
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
  getTopicOrUndefined,
  labelsDelta,
  listProjectTopics,
  listTopicSubscriptions,
  onScope,
  PUBSUB_POLL,
  PUBSUB_TIMEOUT,
  retryWhileBusy,
  sameDuration,
} from "./internal.ts";

/** Spec defaults of `topicSettings`. */
const DEFAULT_RETENTION = "168h";
const DEFAULT_ACL = ["0.0.0.0/0"];

export interface TopicProps {
  /**
   * Name of the topic in the STACKIT portal, up to 36 letters, digits, spaces and `-`.
   * It isn't the topic's identity, so changing it updates in place.
   *
   * If omitted, a name is generated from the stack, stage and logical ID.
   */
  displayName?: string;
  /**
   * Longer text describing the topic, up to 1024 characters. Omit to leave the live
   * value alone.
   */
  description?: string;
  /**
   * How long a message stays stored: a number and `s`, `m` or `h`, from `1s` to `168h`.
   * Omit to leave the live value alone.
   *
   * @default "168h"
   */
  retention?: string;
  /**
   * The IP ranges, in CIDR notation, that may reach the topic and its subscriptions. A
   * host that publishes or pulls needs its egress address in here. Omit to leave the
   * live value alone.
   *
   * @default ["0.0.0.0/0"]
   */
  acl?: string[];
  /**
   * Whether to collect metrics for the topic. Omit to leave the live value alone.
   *
   * @default false
   */
  metrics?: boolean;
  /**
   * Whether to send the topic's service logs. Omit to leave the live value alone.
   *
   * @default false
   */
  serviceLogs?: boolean;
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`, `alchemy.stage`,
   * `alchemy.id`, `alchemy.instance`) are always merged in. Updates in place.
   */
  labels?: Record<string, string>;
  /**
   * Project that owns the topic. Defaults to the profile's project. Changing it replaces
   * the topic.
   */
  projectId?: string;
  /**
   * Region of the topic. Defaults to the profile's region. Changing it replaces the
   * topic.
   */
  region?: string;
  /**
   * Also delete the subscriptions on the topic that aren't in this stack, with their
   * unacknowledged messages, when the topic is destroyed or replaced. Without it, such a
   * subscription stops the delete with `Stackit.PubSub.TopicNotEmpty`.
   *
   * @default false
   */
  forceDestroy?: boolean;
}

/** The settings of a topic, with the spec's defaults filled in. */
export interface TopicSettings {
  /** How long a message stays stored. */
  retention: string;
  /** The IP ranges that may reach the topic and its subscriptions. */
  acl: string[];
  /** Whether metrics are collected. */
  metrics: boolean;
  /** Whether service logs are sent. */
  serviceLogs: boolean;
}

export interface TopicAttributes {
  /** STACKIT topic id (UUID). Stable across updates. */
  topicId: string;
  /** Project that owns the topic. */
  projectId: string;
  /** Region of the topic. */
  region: string;
  /** Name of the topic in the STACKIT portal. */
  displayName: string;
  /** Description of the topic, if any. */
  description: string | undefined;
  /** Topic state; `active` after a deploy. */
  state: string;
  /** URI the API reports for reaching the topic, if any. */
  uri: string | undefined;
  /** The topic's settings. */
  settings: TopicSettings;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
  /** When the topic was created. */
  createTime: string;
}

export type Topic = Resource<"Stackit.PubSub.Topic", TopicProps, TopicAttributes, never, Providers>;

/** A topic still has subscriptions when it is deleted, which the delete would take with it. */
export class TopicNotEmpty extends Data.TaggedError("Stackit.PubSub.TopicNotEmpty")<{
  readonly topicId: string;
  readonly subscriptions: ReadonlyArray<string>;
  readonly message: string;
}> {}

/**
 * A STACKIT Pub/Sub topic: an at-least-once message stream that publishers write to and
 * `Stackit.PubSub.Subscription`s read from. Messages are pulled; the API has no push
 * delivery.
 *
 * Everything but the project and region updates in place, including the display name,
 * because the topic's identity is a UUID the API assigns. Creates, updates and deletes
 * are asynchronous; deploys wait until the topic is `active`, and destroys until it is
 * gone.
 *
 * Ownership is tracked with STACKIT labels. Without state, a topic with the same explicit
 * `displayName` that lacks them is reported as unowned, and only taken over with
 * `--adopt`.
 *
 * Pub/Sub is in beta on STACKIT.
 *
 * :::caution[Changing `projectId` or `region` replaces the Topic]
 * A deploy creates a new, empty topic and deletes the old one with its messages.
 *
 * Deleting a topic that still has subscriptions the stack doesn't know about fails
 * with `Stackit.PubSub.TopicNotEmpty`, which names them, rather than deleting them.
 * Set `forceDestroy` to delete them, or delete them first. Only `alchemy unsafe nuke`
 * goes past that without the prop. An explicit `displayName` with a `projectId` or
 * `region` that isn't known at plan time has to delete the old topic first, before
 * anything has moved its subscriptions away, so that deploy fails the same way until
 * you take them out of the stack.
 * :::
 *
 * ### Creating a Topic
 * **Example:** A topic with a generated name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const topic = yield* Stackit.PubSub.Topic("Orders", {});
 * ```
 *
 * **Example:** A named topic with a description and labels
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const topic = yield* Stackit.PubSub.Topic("Orders", {
 *   displayName: "orders",
 *   description: "Order events from the shop",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Keeping Messages
 * **Example:** Keep messages for one day
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const topic = yield* Stackit.PubSub.Topic("Orders", {
 *   retention: "24h",
 * });
 * ```
 *
 * ### Restricting Access
 * **Example:** Only reach the topic from your own network
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // A host that binds this topic needs its egress address in here too.
 * const topic = yield* Stackit.PubSub.Topic("Orders", {
 *   acl: ["203.0.113.0/24"],
 * });
 * ```
 *
 * ### Observing a Topic
 * **Example:** Turn on metrics and service logs
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const topic = yield* Stackit.PubSub.Topic("Orders", {
 *   metrics: true,
 *   serviceLogs: true,
 * });
 * ```
 *
 * ### Publishing Messages
 * **Example:** Publish from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Orders = Stackit.PubSub.Topic("Orders", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const publish = yield* Stackit.PubSub.Publish(yield* Orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* publish({ messages: [{ data: "order placed" }] });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PubSub.PublishHttp)),
 * ) {}
 * ```
 *
 * ### Consuming Messages
 * **Example:** A topic with a subscription for a worker process
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const topic = yield* Stackit.PubSub.Topic("Orders", {});
 * const subscription = yield* Stackit.PubSub.Subscription("Billing", {
 *   topicId: topic.topicId,
 * });
 * // Pull it with Stackit.PubSub.Pull, or consume it in a long-lived host
 * // with Stackit.PubSub.SubscriptionEventSource.
 * ```
 *
 * ### Deleting a Topic with Subscriptions
 * **Example:** Let a destroy take subscriptions made at runtime with it
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // Subscriptions made in the portal, by another team or through
 * // Stackit.PubSub.CreateSubscription go too, with their unacknowledged messages.
 * const topic = yield* Stackit.PubSub.Topic("Orders", {
 *   forceDestroy: true,
 * });
 * ```
 *
 * ### Event Sources
 * Pub/Sub has no push delivery, so a host keeps pulling for its whole life. Use a host
 * that keeps running, such as a `Stackit.ContainerApplications.Application`, a
 * `Stackit.IaaS.Service` or a `Kubernetes.Deployment`. Delivery is at least once, so a
 * handler has to tolerate running twice.
 *
 * **Example:** Consume a subscription from an Application
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 *
 * export const Apps = Stackit.ContainerApplications.Environment("Apps", {});
 * export const Orders = Stackit.PubSub.Topic("Orders", {});
 * export const Billing = Orders.pipe(
 *   Effect.flatMap((topic) => Stackit.PubSub.Subscription("Billing", { topicId: topic.topicId })),
 * );
 *
 * export default class BillingWorker extends Stackit.ContainerApplications.Application<BillingWorker>()(
 *   "BillingWorker",
 *   Effect.gen(function* () {
 *     const apps = yield* Apps;
 *     return {
 *       main: import.meta.url,
 *       environmentId: apps.environmentId,
 *       registry: { repository: "ghcr.io/my-org/billingworker" },
 *     };
 *   }),
 *   Effect.gen(function* () {
 *     yield* Stackit.PubSub.consumeSubscriptionMessages(
 *       Billing,
 *       { maxMessages: 32, concurrency: 8 },
 *       (message) => Effect.log(message.text),
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
export const Topic = Resource<Topic>("Stackit.PubSub.Topic");

const toAttrs = (scope: ProjectScope, topic: pubsub.TopicResponse): TopicAttributes => ({
  topicId: topic.id,
  projectId: scope.projectId,
  region: scope.region,
  displayName: topic.displayName,
  description: topic.description === "" ? undefined : topic.description,
  state: topic.state,
  uri: topic.uri === "" ? undefined : topic.uri,
  settings: {
    retention: topic.settings?.retention ?? DEFAULT_RETENTION,
    acl: [...(topic.settings?.acl ?? DEFAULT_ACL)],
    metrics: topic.settings?.metrics ?? false,
    serviceLogs: topic.settings?.serviceLogs ?? false,
  },
  labels: stripInternalLabels(topic.labels),
  createTime: topic.createTime,
});

/** The settings a deploy asks for. An unset prop leaves the live value alone. */
const desiredSettings = (props: TopicProps): pubsub.TopicSettings => ({
  ...(props.retention !== undefined ? { retention: props.retention } : {}),
  ...(props.acl !== undefined ? { acl: [...props.acl] } : {}),
  ...(props.metrics !== undefined ? { metrics: props.metrics } : {}),
  ...(props.serviceLogs !== undefined ? { serviceLogs: props.serviceLogs } : {}),
});

const settingsDrifted = (observed: TopicSettings, desired: pubsub.TopicSettings) =>
  (desired.retention !== undefined && !sameDuration(observed.retention, desired.retention)) ||
  (desired.acl !== undefined && !sameMembers(observed.acl, desired.acl)) ||
  (desired.metrics !== undefined && observed.metrics !== desired.metrics) ||
  (desired.serviceLogs !== undefined && observed.serviceLogs !== desired.serviceLogs);

/** What a PATCH has to send: every drifted aspect, diffed against the observed topic. */
const topicDelta = (
  scope: ProjectScope,
  topic: pubsub.TopicResponse,
  props: TopicProps,
  displayName: string,
  labels: Record<string, string>,
) => {
  const observed = toAttrs(scope, topic);
  const settings = desiredSettings(props);
  const labelChange = labelsDelta(topic.labels, labels);
  return {
    ...(observed.displayName !== displayName ? { displayName } : {}),
    ...(props.description !== undefined && observed.description !== (props.description || undefined)
      ? { description: props.description }
      : {}),
    // Whole: the spec doesn't say whether a PATCH merges or replaces the settings.
    ...(settingsDrifted(observed.settings, settings)
      ? { settings: { ...observed.settings, ...settings } }
      : {}),
    ...(labelChange !== undefined ? { labels: labelChange } : {}),
  };
};

/** This generation's topic: only that can be claimed without state. */
const findGeneration = (scope: ProjectScope, id: string, instanceId: string) =>
  Effect.gen(function* () {
    for (const topic of yield* listProjectTopics(scope)) {
      if (
        topic.state !== "deleting" &&
        hasInstanceLabel(instanceId, topic.labels) &&
        (yield* hasAlchemyLabels(id, topic.labels))
      ) {
        return topic;
      }
    }
    return undefined;
  });

const waitForTopicGone = (scope: ProjectScope, topicId: string) =>
  waitUntilGone({
    resource: `STACKIT Pub/Sub topic ${topicId}`,
    read: getTopicOrUndefined(scope, topicId),
    state: (topic) => topic.state,
    timeout: PUBSUB_TIMEOUT,
    ...PUBSUB_POLL,
  });

/**
 * Wait for the topic's subscriptions to go, then refuse if any are left. One a destroy
 * deleted is gone by now. What remains is someone else's, or one of this stack that a
 * delete-first replacement of the topic hasn't reached.
 */
const assertNoSubscriptions = (scope: ProjectScope, topicId: string) =>
  Effect.gen(function* () {
    const left = yield* childrenLeftAfterSettling(listTopicSubscriptions(scope, topicId));
    if (left.length === 0) return;
    const names = left.map((subscription) => subscription.displayName);
    return yield* new TopicNotEmpty({
      topicId,
      subscriptions: names,
      message: `Topic ${topicId} still has subscriptions: ${names.join(", ")}. Deleting it would delete them and their unacknowledged messages. Delete them first, or set forceDestroy on the topic.`,
    });
  });

export const TopicProvider = () =>
  Provider.succeed(Topic, {
    stables: ["topicId", "projectId", "region"],

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const topics = yield* listProjectTopics(scope);
      return topics
        .filter((topic) => isAlchemyOwned(topic.labels))
        .map((topic) => toAttrs(scope, topic));
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An explicit name may have to be unique, which the spec doesn't say, so the old
      // topic goes first when the new one may land in the same scope.
      if (hasUnresolvedTrigger<TopicProps>(news, ["projectId", "region"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<TopicProps>(news, "displayName") !== undefined,
        } as const;
      }
      const scope = yield* resolveProjectScope(triggerProps<TopicProps>(news), undefined);
      if (scope.projectId !== output.projectId || scope.region !== output.region) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      if (output?.topicId !== undefined) {
        const byId = yield* getTopicOrUndefined(scope, output.topicId);
        if (byId !== undefined && byId.state !== "deleting") return toAttrs(scope, byId);
      }
      const topics = (yield* listProjectTopics(scope)).filter(
        (topic) => topic.state !== "deleting",
      );
      // A crashed create has neither state nor a previous generation, and any generation
      // of this logical id is ours. A replacement only owns its own.
      const generation = readGeneration({ instanceId, output, previous });
      for (const topic of topics) {
        if (
          (yield* hasAlchemyLabels(id, topic.labels)) &&
          (generation === undefined || hasInstanceLabel(generation, topic.labels))
        ) {
          return toAttrs(scope, topic);
        }
      }
      if (olds?.displayName === undefined) return undefined;
      // A display name found twice is evidently no identity, so it claims nothing.
      const named = topics.filter((topic) => topic.displayName === olds.displayName);
      if (named.length !== 1) return undefined;
      const attrs = toAttrs(scope, named[0]!);
      const isPrevious =
        previous?.topicId === attrs.topicId &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const displayName =
        news.displayName ?? output?.displayName ?? (yield* generatedDisplayName(id));
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);
      const resource = `STACKIT Pub/Sub topic ${displayName}`;

      // 1. Observe — `output` is a cache for the id, and only names the desired topic
      // while it sits in the same project and region. Without it, only this generation's
      // topic can be claimed.
      let current: pubsub.TopicResponse | undefined =
        output?.topicId !== undefined &&
        output.projectId === scope.projectId &&
        output.region === scope.region
          ? yield* getTopicOrUndefined(scope, output.topicId)
          : undefined;
      current ??= yield* findGeneration(scope, id, instanceId);
      // A delete in flight (an interrupted destroy): let it finish.
      if (current?.state === "deleting") {
        yield* waitForTopicGone(scope, current.id);
        current = undefined;
      }

      // 2. Ensure — a 409 may be our own create racing, so look again before failing.
      if (current === undefined) {
        const settings = desiredSettings(news);
        const created = yield* retryWhileBusy(
          pubsub
            .createTopic({
              ...onScope(scope),
              displayName,
              ...(news.description !== undefined ? { description: news.description } : {}),
              labels,
              ...(Object.keys(settings).length > 0 ? { settings } : {}),
            })
            .pipe(
              Effect.catchTag("Conflict", (error) =>
                findGeneration(scope, id, instanceId).pipe(
                  Effect.flatMap((found) =>
                    found === undefined ? Effect.fail(error) : Effect.succeed(found),
                  ),
                ),
              ),
            ),
        );
        current = created;
      }
      const topicId = current.id;

      const settle = (applied: (topic: pubsub.TopicResponse) => boolean) =>
        waitFor({
          resource,
          // A topic just created can take a moment to be readable.
          read: getTopicOrUndefined(scope, topicId),
          ready: (topic) => topic?.state === "active" && applied(topic),
          state: (topic) => topic?.state ?? "not visible yet",
          timeout: PUBSUB_TIMEOUT,
          ...PUBSUB_POLL,
        });
      current = (yield* settle(() => true))!;

      // 3. Sync — one PATCH with every drifted aspect. Waiting for the new values too
      // means a read from before the PATCH can't pass. Labels aren't awaited: whether a
      // PATCH replaces or merges the map is undocumented, and that must not stall a deploy.
      const delta = topicDelta(scope, current, news, displayName, labels);
      if (Object.keys(delta).length > 0) {
        yield* retryWhileBusy(pubsub.updateTopic({ ...onScope(scope), topicId, ...delta }));
        current = (yield* settle((topic) => {
          const { labels: _labels, ...rest } = topicDelta(scope, topic, news, displayName, labels);
          return Object.keys(rest).length === 0;
        }))!;
      }

      // 4. Return
      return toAttrs(scope, current);
    }),

    delete: Effect.fn(function* ({ olds, output, force }) {
      const scope = { projectId: output.projectId, region: output.region };
      const current = yield* getTopicOrUndefined(scope, output.topicId);
      if (current === undefined) return;
      if (current.state !== "deleting") {
        // The API's `force` deletes subscriptions we may not own, so it takes an opt-in:
        // the prop, or `alchemy unsafe nuke`.
        const cascade = olds?.forceDestroy === true || force === true;
        if (!cascade) yield* assertNoSubscriptions(scope, output.topicId);
        yield* retryWhileBusy(
          pubsub.deleteTopic({
            ...onScope(scope),
            topicId: output.topicId,
            ...(cascade ? { force: true } : {}),
          }),
        ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
      yield* waitForTopicGone(scope, output.topicId);
    }),
  });
