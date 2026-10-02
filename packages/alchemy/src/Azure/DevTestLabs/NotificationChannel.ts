import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createLabResourceName,
  DEVTESTLAB_NAMESPACE,
  diverges,
  labLocation,
} from "./Common.ts";

export interface NotificationChannelProps {
  /** Resource group of the lab. Changing it replaces the channel. */
  resourceGroup: string;
  /** Name of the lab. Changing it replaces the channel. */
  lab: string;
  /**
   * Channel name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the channel.
   */
  name?: string;
  /** Events the channel is notified of. */
  events: ("AutoShutdown" | "Cost")[];
  /** Webhook URL that receives notifications. */
  webHookUrl?: string;
  /** Semicolon-separated email recipients. */
  emailRecipient?: string;
  /** Locale of notification emails, e.g. `"en"`. */
  notificationLocale?: string;
  /** Description of the channel. */
  description?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NotificationChannel extends Resource<
  "Azure.DevTestLabs.NotificationChannel",
  NotificationChannelProps,
  {
    /** Name of the channel. */
    notificationChannelName: string;
    /** ARM resource ID of the channel. */
    notificationChannelId: string;
    /** Resource group of the lab. */
    resourceGroup: string;
    /** Name of the lab. */
    lab: string;
    /** Events the channel is notified of. */
    events: string[];
    /** Unique immutable identifier (GUID) of the channel. */
    uniqueIdentifier: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A DevTest Labs notification channel — a webhook and/or email recipients
 * notified of lab events such as upcoming auto-shutdown or cost
 * thresholds.
 *
 * @see https://learn.microsoft.com/azure/devtest-labs/devtest-lab-auto-shutdown#configure-autoshutdown-for-lab-vms
 *
 * ### Email Notifications
 * **Example:** Email the team before auto-shutdown
 * ```typescript
 * const channel = yield* Azure.DevTestLabs.NotificationChannel("ops", {
 *   resourceGroup: group.resourceGroupName,
 *   lab: lab.labName,
 *   events: ["AutoShutdown"],
 *   emailRecipient: "ops@example.com",
 *   notificationLocale: "en",
 * });
 * ```
 *
 * ### Webhooks
 * **Example:** Post cost alerts to a webhook
 * ```typescript
 * const channel = yield* Azure.DevTestLabs.NotificationChannel("cost", {
 *   resourceGroup: group.resourceGroupName,
 *   lab: lab.labName,
 *   events: ["Cost"],
 *   webHookUrl: "https://example.com/hooks/lab-cost",
 * });
 * ```
 *
 * @resource
 */
export const NotificationChannel = Resource<NotificationChannel>(
  "Azure.DevTestLabs.NotificationChannel",
);

const getChannel = (
  subscriptionId: string,
  resourceGroupName: string,
  labName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    devtestlabs.GetNotificationChannel({
      subscriptionId,
      resourceGroupName,
      labName,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  lab: string,
  name: string,
  c: devtestlabs.GetNotificationChannelResponse,
): NotificationChannel["Attributes"] => ({
  notificationChannelName: name,
  notificationChannelId: c.id ?? "",
  resourceGroup,
  lab,
  events: (c.properties?.events ?? []).flatMap((e) =>
    e.eventName ? [e.eventName] : [],
  ),
  uniqueIdentifier: c.properties?.uniqueIdentifier,
  tags: userTags(c.tags),
});

export const NotificationChannelProvider = () =>
  Provider.succeed(NotificationChannel, {
    stables: [
      "notificationChannelName",
      "notificationChannelId",
      "resourceGroup",
      "lab",
    ],

    // Channels are deleted with their lab.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.lab.toLowerCase() !== output.lab.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.notificationChannelName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const lab = output?.lab ?? olds?.lab;
      if (resourceGroup === undefined || lab === undefined) return undefined;
      const name =
        output?.notificationChannelName ??
        olds?.name ??
        (yield* createLabResourceName(id));
      const observed = yield* getChannel(
        subscriptionId,
        resourceGroup,
        lab,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, lab, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DEVTESTLAB_NAMESPACE);
      const { resourceGroup, lab } = news;
      const name =
        news.name ??
        output?.notificationChannelName ??
        (yield* createLabResourceName(id));
      const tags = yield* desiredTags(id, news.tags);
      const properties: devtestlabs.NotificationChannelPropertiesInput = {
        events: news.events.map((eventName) => ({ eventName })),
        webHookUrl: news.webHookUrl,
        emailRecipient: news.emailRecipient,
        notificationLocale: news.notificationLocale,
        description: news.description,
      };

      // Observe; webHookUrl is only returned with an explicit $expand.
      let observed = yield* getChannel(subscriptionId, resourceGroup, lab, name);

      // Ensure + sync: the PUT is a synchronous full upsert.
      if (
        observed === undefined ||
        diverges(
          { ...properties, webHookUrl: undefined },
          observed.properties,
        ) ||
        (news.webHookUrl !== undefined &&
          news.webHookUrl !== observed.properties?.webHookUrl) ||
        tagsDiffer(observed.tags, tags)
      ) {
        observed = yield* devtestlabs.NotificationChannelsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          labName: lab,
          name,
          location:
            observed?.location ??
            (yield* labLocation(subscriptionId, resourceGroup, lab)),
          tags,
          properties,
        });
      }

      return toAttrs(resourceGroup, lab, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devtestlabs.DeleteNotificationChannel({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          labName: output.lab,
          name: output.notificationChannelName,
        }),
      );
      yield* waitUntilGone(
        `notification channel ${output.notificationChannelName}`,
        getChannel(
          subscriptionId,
          output.resourceGroup,
          output.lab,
          output.notificationChannelName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
