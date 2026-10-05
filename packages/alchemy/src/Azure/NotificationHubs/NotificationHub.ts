import * as notificationhubs from "@distilled.cloud/azure/notificationhubs";
import * as Data from "effect/Data";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createEntityName,
  credentialsNeedWrite,
  hashCredentials,
  type PnsCredentials,
  sameName,
} from "./internal.ts";

export interface NotificationHubProps {
  /** Resource group of the namespace. Changing it replaces the hub. */
  resourceGroup: string;
  /**
   * Notification Hubs namespace that holds the hub. The hub is created in
   * the namespace's location. Changing it replaces the hub.
   */
  namespace: string;
  /**
   * Hub name: 1-260 letters, digits, `.`, `-`, `_`, and `/`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the hub.
   */
  name?: string;
  /**
   * How long device registrations live without a refresh, as a .NET
   * TimeSpan (`d.hh:mm:ss`), e.g. `"90.00:00:00"`.
   * @default Azure's default (effectively unlimited)
   */
  registrationTtl?: string;
  /**
   * Push notification service credentials (APNs, FCM/GCM, WNS, Web Push,
   * ...). Secret fields accept `Redacted` values. Removing this prop leaves
   * the credentials in place.
   */
  pnsCredentials?: PnsCredentials;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NotificationHub extends Resource<
  "Azure.NotificationHubs.NotificationHub",
  NotificationHubProps,
  {
    /** Name of the hub. */
    notificationHubName: string;
    /** ARM resource ID of the hub. */
    notificationHubId: string;
    /** Namespace that holds the hub. */
    namespaceName: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Location of the hub (the namespace's location). */
    location: string;
    /** Registration time-to-live (.NET TimeSpan). */
    registrationTtl: string | undefined;
    /** Daily maximum of active devices allowed by the namespace tier. */
    dailyMaxActiveDevices: number | undefined;
    /** sha256 of the last written `pnsCredentials` (change detection). */
    pnsCredentialsHash: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure notification hub — the push engine inside a Notification Hubs
 * namespace. Devices register with the hub, and backends send one
 * notification that the hub fans out through APNs, FCM, WNS, and Web Push
 * using the hub's push notification service credentials.
 *
 * @see https://learn.microsoft.com/azure/notification-hubs/notification-hubs-push-notification-overview
 *
 * ### Creating a Hub
 * **Example:** Hub in a free namespace
 * ```typescript
 * const ns = yield* Azure.NotificationHubs.Namespace("push", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const hub = yield* Azure.NotificationHubs.NotificationHub("app", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: ns.namespaceName,
 *   registrationTtl: "90.00:00:00",
 * });
 * ```
 *
 * ### Configuring Push Credentials
 * **Example:** APNs token authentication
 * ```typescript
 * const hub = yield* Azure.NotificationHubs.NotificationHub("app", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: ns.namespaceName,
 *   pnsCredentials: {
 *     apnsCredential: {
 *       properties: {
 *         endpoint: "https://api.push.apple.com:443/3/device",
 *         keyId: "ABC123DEFG",
 *         appId: "TEAMID1234",
 *         appName: "com.example.app",
 *         token: apnsPrivateKey,
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const NotificationHub = Resource<NotificationHub>(
  "Azure.NotificationHubs.NotificationHub",
);

export class NotificationHubNamespaceMissing extends Data.TaggedError(
  "Azure.NotificationHubs.NamespaceMissing",
)<{ readonly namespaceName: string; readonly message: string }> {}

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  namespaceName: string;
  notificationHubName: string;
}

type ObservedHub =
  | notificationhubs.GetNotificationHubResponse
  | notificationhubs.NotificationHubResource;

const getHub = (where: Where) =>
  orUndefinedIfNotFound(notificationhubs.GetNotificationHub(where));

const toAttrs = (
  where: Where,
  observed: ObservedHub,
  pnsCredentialsHash: string | undefined,
): NotificationHub["Attributes"] => ({
  notificationHubName: where.notificationHubName,
  notificationHubId: observed.id ?? "",
  namespaceName: where.namespaceName,
  resourceGroup: where.resourceGroupName,
  location: observed.location,
  registrationTtl: observed.properties?.registrationTtl,
  dailyMaxActiveDevices: observed.properties?.dailyMaxActiveDevices,
  pnsCredentialsHash,
  tags: userTags(observed.tags),
});

export const NotificationHubProvider = () =>
  Provider.succeed(NotificationHub, {
    stables: [
      "notificationHubName",
      "notificationHubId",
      "namespaceName",
      "resourceGroup",
      "location",
    ],

    // Hubs live inside a namespace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespaceName) ||
        (news.name !== undefined &&
          !sameName(news.name, output.notificationHubName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const namespaceName = output?.namespaceName ?? olds?.namespace;
      if (resourceGroupName === undefined || namespaceName === undefined) {
        return undefined;
      }
      const where = {
        subscriptionId,
        resourceGroupName,
        namespaceName,
        notificationHubName:
          output?.notificationHubName ??
          olds?.name ??
          (yield* createEntityName(id, 64)),
      };
      const observed = yield* getHub(where);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed, output?.pnsCredentialsHash);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.NotificationHubs");
      const where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        namespaceName: news.namespace,
        notificationHubName:
          news.name ??
          output?.notificationHubName ??
          (yield* createEntityName(id, 64)),
      };
      const tags = yield* desiredTags(id, news.tags);
      const credentialsHash = yield* hashCredentials(news.pnsCredentials);
      const waitReady = waitForProvisioned(
        `notification hub ${where.notificationHubName}`,
        getHub(where),
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );

      // Observe.
      let observed: ObservedHub | undefined = yield* getHub(where);
      let lastCredentialsHash = output?.pnsCredentialsHash;

      // Ensure. The hub lives in its namespace's location.
      if (observed === undefined) {
        const ns = yield* orUndefinedIfNotFound(
          notificationhubs.GetNamespace({
            subscriptionId,
            resourceGroupName: where.resourceGroupName,
            namespaceName: where.namespaceName,
          }),
        );
        if (ns === undefined) {
          return yield* new NotificationHubNamespaceMissing({
            namespaceName: where.namespaceName,
            message: `Notification Hubs namespace ${where.namespaceName} does not exist`,
          });
        }
        yield* notificationhubs.NotificationHubsCreateOrUpdate({
          ...where,
          location: ns.location,
          tags,
          properties: {
            registrationTtl: news.registrationTtl,
            ...news.pnsCredentials,
          },
        });
        observed = yield* waitReady;
        lastCredentialsHash = credentialsHash;
      }

      // Sync settings, credentials, and tags against observed state.
      const properties: notificationhubs.NotificationHubPropertiesInput = {};
      if (
        news.registrationTtl !== undefined &&
        observed.properties?.registrationTtl !== news.registrationTtl
      ) {
        properties.registrationTtl = news.registrationTtl;
      }
      if (news.pnsCredentials !== undefined) {
        const observedCredentials = yield* orUndefinedIfNotFound(
          notificationhubs.GetNotificationHubPnsCredentials(where),
        );
        if (
          credentialsNeedWrite(
            observedCredentials?.properties,
            news.pnsCredentials,
            credentialsHash,
            lastCredentialsHash,
          )
        ) {
          Object.assign(properties, news.pnsCredentials);
        }
      }
      const propsChanged = Object.keys(properties).length > 0;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (propsChanged || tagsChanged) {
        yield* notificationhubs.UpdateNotificationHub({
          ...where,
          ...(propsChanged ? { properties } : {}),
          ...(tagsChanged ? { tags } : {}),
        });
        observed = yield* waitReady;
      }

      return toAttrs(where, observed, credentialsHash);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        namespaceName: output.namespaceName,
        notificationHubName: output.notificationHubName,
      };
      yield* ignoreNotFound(notificationhubs.DeleteNotificationHub(where));
      yield* waitUntilGone(
        `notification hub ${output.notificationHubName}`,
        getHub(where),
      );
    }),

    nuke: { dependsOn: ["Azure.NotificationHubs.Namespace"] },
  });
