import * as notificationhubs from "@distilled.cloud/azure/notificationhubs";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  credentialsNeedWrite,
  hashCredentials,
  type PnsCredentials,
  sameLocation,
  sameName,
} from "./internal.ts";

export type NotificationHubsSkuName = "Free" | "Basic" | "Standard";
export type NotificationHubsNetworkAcls = notificationhubs.NetworkAcls;
export type { PnsCredentials as NotificationHubsPnsCredentials };

export interface NamespaceProps {
  /**
   * Resource group the namespace is created in. Changing it replaces the
   * namespace.
   */
  resourceGroup: string;
  /**
   * Globally unique namespace name (`<name>.servicebus.windows.net`): 6-50
   * letters, digits, and hyphens, starting with a letter and ending with a
   * letter or digit. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the namespace.
   */
  name?: string;
  /**
   * Azure location of the namespace. Changing it replaces the namespace.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Pricing tier. `Free` (1M pushes, 500 active devices) costs nothing;
   * `Basic` and `Standard` are billed per namespace.
   * @default "Free"
   */
  sku?: NotificationHubsSkuName;
  /**
   * Scale units (`Standard` only).
   */
  capacity?: number;
  /**
   * Availability-zone redundancy (`Standard` only). Changing it replaces the
   * namespace.
   * @default Azure's default
   */
  zoneRedundancy?: "Enabled" | "Disabled";
  /**
   * Geo-replication region: `Default`, `None`, or a paired region name.
   * @default Azure's default
   */
  replicationRegion?: string;
  /**
   * Whether the public endpoint accepts traffic.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * IP rules and the default public-network rule (`Standard` only).
   */
  networkAcls?: NotificationHubsNetworkAcls;
  /**
   * Namespace-level push notification service credentials, shared by every
   * hub in the namespace. Secret fields accept `Redacted` values. Removing
   * this prop leaves the credentials in place.
   */
  pnsCredentials?: PnsCredentials;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Namespace extends Resource<
  "Azure.NotificationHubs.Namespace",
  NamespaceProps,
  {
    /** Name of the namespace. */
    namespaceName: string;
    /** ARM resource ID of the namespace; use it as a role-assignment scope. */
    namespaceId: string;
    /** Resource group that holds the namespace. */
    resourceGroup: string;
    /** Location of the namespace. */
    location: string;
    /** Pricing tier (`Free`, `Basic`, or `Standard`). */
    sku: string;
    /** Scale units. */
    capacity: number | undefined;
    /** Endpoint, e.g. `https://<name>.servicebus.windows.net:443/`. */
    serviceBusEndpoint: string;
    /** Azure Monitor metric ID. */
    metricId: string | undefined;
    /** Namespace status (e.g. `Created`). */
    status: string | undefined;
    /** Zone redundancy. */
    zoneRedundancy: string | undefined;
    /** Geo-replication region. */
    replicationRegion: string | undefined;
    /** Whether the public endpoint accepts traffic. */
    publicNetworkAccess: string | undefined;
    /** sha256 of the last written `pnsCredentials` (change detection). */
    pnsCredentialsHash: string | undefined;
    /**
     * Primary connection string of the built-in
     * `RootManageSharedAccessKey` rule (full Manage rights).
     */
    primaryConnectionString: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Notification Hubs namespace — the container for notification
 * hubs, with its own `<name>.servicebus.windows.net` endpoint. Notification
 * Hubs fan push notifications out to iOS (APNs), Android (FCM), Windows
 * (WNS), and browsers (Web Push) from a single API.
 *
 * The `Free` tier (default) costs nothing. The connection string of the
 * built-in `RootManageSharedAccessKey` rule is exposed as a secret; prefer
 * least-privilege authorization rules for applications.
 *
 * @see https://learn.microsoft.com/azure/notification-hubs/notification-hubs-push-notification-overview
 *
 * ### Creating a Namespace
 * **Example:** Free namespace
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const ns = yield* Azure.NotificationHubs.Namespace("push", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Standard namespace with zone redundancy
 * ```typescript
 * const ns = yield* Azure.NotificationHubs.Namespace("push", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Standard",
 *   zoneRedundancy: "Enabled",
 *   tags: { team: "mobile" },
 * });
 * ```
 *
 * ### Restricting Network Access
 * **Example:** Allow one IP range
 * ```typescript
 * const ns = yield* Azure.NotificationHubs.Namespace("push", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Standard",
 *   networkAcls: {
 *     ipRules: [{ ipMask: "203.0.113.0/24", rights: ["Send", "Listen"] }],
 *     publicNetworkRule: { rights: [] },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Namespace = Resource<Namespace>(
  "Azure.NotificationHubs.Namespace",
);

type ObservedNamespace =
  | notificationhubs.GetNamespaceResponse
  | notificationhubs.NamespaceResource;

/** 6-50 chars, starts with a letter, ends with a letter or digit. */
const createNamespaceName = Effect.fn(function* (id: string) {
  const name = (yield* createPhysicalName({
    id,
    maxLength: 50,
    lowercase: true,
  }))
    .replace(/-{2,}/g, "-")
    .replace(/-+$/, "");
  return /^[a-z]/.test(name) ? name : `nh-${name}`.slice(0, 50);
});

const getNamespace = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
) =>
  orUndefinedIfNotFound(
    notificationhubs.GetNamespace({
      subscriptionId,
      resourceGroupName,
      namespaceName,
    }),
  );

const ROOT_RULE = "RootManageSharedAccessKey";

const rootConnectionString = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
) =>
  orUndefinedIfNotFound(
    notificationhubs.ListNamespaceKeys({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      authorizationRuleName: ROOT_RULE,
    }),
  ).pipe(
    Effect.map((keys) =>
      keys?.primaryConnectionString === undefined
        ? undefined
        : Redacted.make(keys.primaryConnectionString),
    ),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedNamespace,
  primaryConnectionString: Redacted.Redacted<string> | undefined,
  pnsCredentialsHash: string | undefined,
): Namespace["Attributes"] => ({
  namespaceName: name,
  namespaceId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  sku: observed.sku?.name ?? "Free",
  capacity: observed.sku?.capacity,
  serviceBusEndpoint: observed.properties?.serviceBusEndpoint ?? "",
  metricId: observed.properties?.metricId,
  status: observed.properties?.status,
  zoneRedundancy: observed.properties?.zoneRedundancy,
  replicationRegion: observed.properties?.replicationRegion,
  publicNetworkAccess: observed.properties?.publicNetworkAccess,
  pnsCredentialsHash,
  primaryConnectionString,
  tags: userTags(observed.tags),
});

const lower = (value: string | undefined) => value?.toLowerCase();

const canonicalAcls = (acls: NotificationHubsNetworkAcls | undefined) =>
  JSON.stringify({
    ipRules: [...(acls?.ipRules ?? [])]
      .map((rule) => ({
        ipMask: rule.ipMask,
        rights: [...rule.rights].map((r) => r.toLowerCase()).sort(),
      }))
      .sort((a, b) => a.ipMask.localeCompare(b.ipMask)),
    publicNetworkRule: [...(acls?.publicNetworkRule?.rights ?? [])]
      .map((r) => r.toLowerCase())
      .sort(),
  });

/**
 * ARM rejects a namespace write while a previous operation on it is still
 * running (`Conflict`); short waits converge.
 */
const whileBusy = {
  while: (e: { readonly _tag: string }) => e._tag === "ResourceConflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 12,
} as const;

export const NamespaceProvider = () =>
  Provider.succeed(Namespace, {
    stables: [
      "namespaceName",
      "namespaceId",
      "resourceGroup",
      "location",
      "serviceBusEndpoint",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* notificationhubs
        .ListNamespaceAll({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListNamespaceAll", page)),
        );
      return (page.value ?? []).flatMap((ns) => {
        const group = resourceGroupOf(ns.id);
        return hasAnyAlchemyTag(ns.tags) &&
          group !== undefined &&
          ns.name !== undefined
          ? [toAttrs(group, ns.name, ns, undefined, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameName(news.name, output.namespaceName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        (news.zoneRedundancy !== undefined &&
          output.zoneRedundancy !== undefined &&
          !sameName(news.zoneRedundancy, output.zoneRedundancy))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.namespaceName ?? olds?.name ?? (yield* createNamespaceName(id));
      const observed = yield* getNamespace(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        name,
        observed,
        yield* rootConnectionString(subscriptionId, resourceGroup, name),
        output?.pnsCredentialsHash,
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.NotificationHubs");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.namespaceName ?? (yield* createNamespaceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const skuName = news.sku ?? "Free";
      const sku = {
        name: skuName,
        tier: skuName,
        ...(news.capacity !== undefined ? { capacity: news.capacity } : {}),
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        namespaceName: name,
      };
      const get = getNamespace(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(
        `notification hubs namespace ${name}`,
        get,
        (ns) => ns.properties?.provisioningState,
        { interval: "5 seconds", times: 120 },
      );
      const credentialsHash = yield* hashCredentials(news.pnsCredentials);

      // Observe.
      let observed = yield* get;
      let lastCredentialsHash = output?.pnsCredentialsHash;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* notificationhubs
          .NamespacesCreateOrUpdate({
            ...where,
            location,
            tags,
            sku,
            properties: {
              namespaceType: "NotificationHub",
              zoneRedundancy: news.zoneRedundancy,
              replicationRegion: news.replicationRegion,
              publicNetworkAccess: news.publicNetworkAccess,
              networkAcls: news.networkAcls,
              pnsCredentials: news.pnsCredentials,
            },
          })
          .pipe(Effect.retry(whileBusy));
        observed = yield* waitReady;
        lastCredentialsHash = credentialsHash;
      }

      // Sync settings and tags against observed state; PATCH only deltas.
      const props = observed.properties ?? {};
      const skuChanged =
        lower(observed.sku?.name) !== lower(skuName) ||
        (news.capacity !== undefined &&
          observed.sku?.capacity !== news.capacity);
      const properties: notificationhubs.NamespacePropertiesInput = {};
      if (
        news.publicNetworkAccess !== undefined &&
        lower(props.publicNetworkAccess) !== lower(news.publicNetworkAccess)
      ) {
        properties.publicNetworkAccess = news.publicNetworkAccess;
      }
      if (
        news.replicationRegion !== undefined &&
        lower(props.replicationRegion) !== lower(news.replicationRegion)
      ) {
        properties.replicationRegion = news.replicationRegion;
      }
      if (
        news.networkAcls !== undefined &&
        canonicalAcls(props.networkAcls) !== canonicalAcls(news.networkAcls)
      ) {
        properties.networkAcls = news.networkAcls;
      }
      if (news.pnsCredentials !== undefined) {
        const observedCredentials = yield* orUndefinedIfNotFound(
          notificationhubs.GetNamespacePnsCredentials(where),
        );
        if (
          credentialsNeedWrite(
            observedCredentials?.properties,
            news.pnsCredentials,
            credentialsHash,
            lastCredentialsHash,
          )
        ) {
          properties.pnsCredentials = news.pnsCredentials;
        }
      }
      const propsChanged = Object.keys(properties).length > 0;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (skuChanged || propsChanged || tagsChanged) {
        yield* notificationhubs
          .UpdateNamespace({
            ...where,
            ...(skuChanged ? { sku } : {}),
            ...(propsChanged ? { properties } : {}),
            ...(tagsChanged ? { tags } : {}),
          })
          .pipe(Effect.retry(whileBusy));
        observed = yield* waitReady;
      }

      return toAttrs(
        resourceGroup,
        name,
        observed,
        yield* rootConnectionString(subscriptionId, resourceGroup, name),
        credentialsHash,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        notificationhubs
          .DeleteNamespace({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            namespaceName: output.namespaceName,
          })
          .pipe(Effect.retry(whileBusy)),
      );
      yield* waitUntilGone(
        `notification hubs namespace ${output.namespaceName}`,
        getNamespace(
          subscriptionId,
          output.resourceGroup,
          output.namespaceName,
        ),
        { interval: "5 seconds", times: 120 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
