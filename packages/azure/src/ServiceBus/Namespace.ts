import * as servicebus from "@distilled.cloud/azure/servicebus";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";

export type ServiceBusSku = "Basic" | "Standard" | "Premium";
export type ServiceBusTlsVersion = servicebus.TlsVersion;
export type ServiceBusIdentityType = servicebus.ManagedServiceIdentityType;

export interface NamespaceIdentity {
  /**
   * Managed identity type: `SystemAssigned`, `UserAssigned`,
   * `SystemAssigned, UserAssigned`, or `None`.
   */
  type: ServiceBusIdentityType;
  /**
   * ARM IDs of user-assigned identities to attach (required for
   * `UserAssigned` types).
   * @default []
   */
  userAssignedIdentityIds?: string[];
}

export interface NamespaceProps {
  /**
   * Resource group the namespace is created in.
   *
   * :::caution
   * Changing it replaces the namespace.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Globally unique namespace name (`<name>.servicebus.windows.net`): 6-50
   * letters, digits, and hyphens, starting with a letter and ending with a
   * letter or digit. If omitted, a unique name is generated from the app,
   * stage, and logical ID.
   *
   * :::caution
   * Changing it replaces the namespace.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the namespace.
   *
   * :::caution
   * Changing it replaces the namespace.
   * :::
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Pricing tier. `Basic` supports queues only; topics and subscriptions
   * need `Standard` or `Premium`. Switching between `Basic` and `Standard`
   * is in place.
   *
   * :::caution
   * Moving to or from `Premium` replaces the namespace.
   * :::
   * @default "Standard"
   */
  sku?: ServiceBusSku;
  /**
   * Premium messaging units (1, 2, 4, 8, or 16 times
   * `premiumMessagingPartitions`). Changes in place. Ignored for Basic and
   * Standard.
   * @default 1 (Premium only)
   */
  capacity?: number;
  /**
   * Spread a Premium namespace across availability zones. Set it when you
   * create the namespace: a later change alone sends no update.
   * @default Azure's default for the region
   */
  zoneRedundant?: boolean;
  /**
   * Premium partitions (1, 2, or 4). Set it when you create the namespace:
   * a later change alone sends no update.
   * @default Azure's default (`1`)
   */
  premiumMessagingPartitions?: number;
  /**
   * Minimum TLS version accepted by the namespace endpoint.
   * @default "1.2"
   */
  minimumTlsVersion?: ServiceBusTlsVersion;
  /**
   * Disable SAS (shared access key) authentication so only Microsoft
   * Entra ID is accepted. When `true`, no connection string is returned.
   * @default false
   */
  disableLocalAuth?: boolean;
  /**
   * Whether the public endpoint accepts traffic. Leave unset when a
   * `NetworkRuleSet` manages it.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled" | "SecuredByPerimeter";
  /**
   * IP address types the endpoint serves.
   * @default Azure's default (`IPv4`)
   */
  ipAddressType?: "IPv4" | "DualStack";
  /**
   * Managed identity of the namespace (used for customer-managed keys).
   * @default the observed identity is kept (none on a new namespace)
   */
  identity?: NamespaceIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface Namespace extends Resource<
  "Azure.ServiceBus.Namespace",
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
    /** Pricing tier. */
    sku: string;
    /** Premium messaging units (undefined for Basic/Standard). */
    capacity: number | undefined;
    /** Endpoint, e.g. `https://<name>.servicebus.windows.net:443/`. */
    serviceBusEndpoint: string;
    /** Fully qualified host name, e.g. `<name>.servicebus.windows.net`. */
    hostName: string;
    /** Azure Monitor metric ID. */
    metricId: string | undefined;
    /** Namespace status (e.g. `Active`). */
    status: string | undefined;
    /** Whether SAS authentication is disabled. */
    disableLocalAuth: boolean;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Tenant ID of the system-assigned identity, if any. */
    tenantId: string | undefined;
    /**
     * Primary connection string of the built-in
     * `RootManageSharedAccessKey` rule (full Manage rights). Undefined when
     * `disableLocalAuth` is set.
     */
    primaryConnectionString: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Service Bus namespace (`Microsoft.ServiceBus/namespaces`): the
 * container for your queues, topics, and subscriptions, with its own
 * `<name>.servicebus.windows.net` endpoint.
 *
 * Alchemy creates a `Standard` namespace in the stack's resource group, with
 * TLS 1.2 as the minimum. Bind the queues, topics, and subscriptions in it to
 * your runtimes: each binding assigns a Service Bus data role on that one
 * entity, so your code never handles a connection string. The connection
 * string of the built-in `RootManageSharedAccessKey` rule is still an
 * attribute (a `Redacted` secret) for tools that need one.
 *
 * :::caution[Changing `name`, `resourceGroup`, `location`, or moving to or from `Premium` replaces the namespace]
 * Alchemy creates a new namespace and deletes the old one with every queue,
 * topic, subscription, and message in it.
 * :::
 *
 * @see https://learn.microsoft.com/azure/service-bus-messaging/service-bus-messaging-overview
 *
 * ### Creating a Namespace
 * **Example:** Standard namespace
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus");
 * // bus.hostName → "<name>.servicebus.windows.net"
 * ```
 *
 * **Example:** Namespace with a fixed name and region
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus", {
 *   name: "contoso-orders-bus",
 *   location: "westeurope",
 * });
 * ```
 *
 * ### Choosing a Tier
 * `Basic` has queues only. `Standard` adds topics, subscriptions, sessions,
 * and transactions. `Premium` runs on dedicated messaging units, accepts
 * messages up to 100 MB, and supports private endpoints, availability zones,
 * and geo-disaster recovery. You can switch between `Basic` and `Standard` in
 * place.
 *
 * **Example:** Basic namespace (queues only)
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus", {
 *   sku: "Basic",
 * });
 * ```
 *
 * **Example:** Premium namespace with two messaging units across zones
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus", {
 *   sku: "Premium",
 *   capacity: 2,
 *   zoneRedundant: true,
 * });
 * ```
 *
 * ### Authentication
 * **Example:** Accept Microsoft Entra ID only
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus", {
 *   disableLocalAuth: true,
 * });
 * // bus.primaryConnectionString is undefined: SAS keys are off
 * ```
 *
 * **Example:** Assign a data role to an identity you manage
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("worker");
 * yield* Azure.Authorization.RoleAssignment("worker-sends", {
 *   scope: bus.namespaceId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.ServiceBusDataSender,
 *   principalId: identity.principalId,
 * });
 * ```
 *
 * **Example:** Send-only SAS rule for a client that needs a connection string
 * ```typescript
 * const producer = yield* Azure.ServiceBus.NamespaceAuthorizationRule("producer", {
 *   namespace: bus.namespaceName,
 *   rights: ["Send"],
 * });
 * // producer.primaryConnectionString is a Redacted secret
 * ```
 *
 * ### Network Access
 * **Example:** Allow one IP range and trusted Azure services
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus", { sku: "Premium" });
 * yield* Azure.ServiceBus.NetworkRuleSet("bus-firewall", {
 *   namespace: bus.namespaceName,
 *   defaultAction: "Deny",
 *   ipRules: [{ ipMask: "203.0.113.0/24" }],
 *   trustedServiceAccessEnabled: true,
 * });
 * ```
 *
 * **Example:** Private endpoint in your virtual network (Premium)
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus", {
 *   sku: "Premium",
 *   publicNetworkAccess: "Disabled",
 * });
 * yield* Azure.Network.PrivateEndpoint("bus-endpoint", {
 *   subnetId: subnet.subnetId,
 *   privateLinkServiceConnections: [
 *     { privateLinkServiceId: bus.namespaceId, groupIds: ["namespace"] },
 *   ],
 * });
 * ```
 *
 * ### Geo-Disaster Recovery
 * Pair two empty `Premium` namespaces in different regions behind one alias.
 * Clients connect to `<alias>.servicebus.windows.net`.
 *
 * **Example:** Pair a primary and a secondary namespace
 * ```typescript
 * const primary = yield* Azure.ServiceBus.Namespace("primary", {
 *   sku: "Premium",
 *   location: "eastus",
 * });
 * const secondary = yield* Azure.ServiceBus.Namespace("secondary", {
 *   sku: "Premium",
 *   location: "westus",
 * });
 * yield* Azure.ServiceBus.DisasterRecoveryConfig("bus-alias", {
 *   namespace: primary.namespaceName,
 *   partnerNamespace: secondary.namespaceId,
 * });
 * ```
 *
 * ### Binding to a runtime
 * Bind the entities in the namespace, not the namespace itself. A queue
 * binding assigns **Azure Service Bus Data Sender** or **Data Receiver** on
 * that queue only.
 *
 * **Example:** Send to a queue and a topic from an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const ordersQueue = yield* Orders;
 *     const eventsTopic = yield* Events;
 *     const orders = yield* Azure.ServiceBus.QueueSend(ordersQueue);
 *     const events = yield* Azure.ServiceBus.TopicWrite(eventsTopic);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* orders.send({ orderId: "42" }, { messageId: "42" });
 *         yield* events.send({ type: "order.created" }, { label: "order.created" });
 *         return HttpServerResponse.text("queued");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(
 *     Effect.provide([
 *       Azure.ServiceBus.QueueSendHttp,
 *       Azure.ServiceBus.TopicWriteHttp,
 *     ]),
 *   ),
 * ) {}
 * ```
 *
 * ### Deleting a Namespace
 * Destroying the namespace deletes every entity and message in it.
 *
 * **Example:** Keep the namespace when the stack is destroyed
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const bus = yield* Azure.ServiceBus.Namespace("bus").pipe(
 *   RemovalPolicy.retain(),
 * );
 * ```
 *
 * @resource
 */
export const Namespace = GroupedResource<Namespace>("Azure.ServiceBus.Namespace");

type ObservedNamespace = servicebus.GetNamespaceResponse | servicebus.SBNamespace;

/** 6-50 chars, starts with a letter, ends with a letter or digit. */
const createNamespaceName = Effect.fn(function* (id: string) {
  const name = (yield* createPhysicalName({
    id,
    maxLength: 50,
    lowercase: true,
  }))
    .replace(/-{2,}/g, "-")
    .replace(/-+$/, "");
  return /^[a-z]/.test(name) ? name : `sb-${name}`.slice(0, 50);
});

const getNamespace = (subscriptionId: string, resourceGroupName: string, namespaceName: string) =>
  orUndefinedIfNotFound(
    servicebus.GetNamespace({
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
  observed: ObservedNamespace,
) =>
  observed.properties?.disableLocalAuth
    ? Effect.succeed(undefined)
    : orUndefinedIfNotFound(
        servicebus.ListNamespaceKeys({
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
): Namespace["Attributes"] => {
  const endpoint = observed.properties?.serviceBusEndpoint ?? "";
  return {
    namespaceName: name,
    namespaceId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    sku: observed.sku?.name ?? "",
    capacity: observed.sku?.name === "Premium" ? observed.sku?.capacity : undefined,
    serviceBusEndpoint: endpoint,
    hostName: endpoint.match(/^https?:\/\/([^:/]+)/)?.[1] ?? `${name}.servicebus.windows.net`,
    metricId: observed.properties?.metricId,
    status: observed.properties?.status,
    disableLocalAuth: observed.properties?.disableLocalAuth ?? false,
    principalId: observed.identity?.principalId,
    tenantId: observed.identity?.tenantId,
    primaryConnectionString,
    tags: userTags(observed.tags),
  };
};

const lower = (value: string | undefined) => value?.toLowerCase();

const identityDiffers = (
  observed: servicebus.Identity | undefined,
  desired: NamespaceIdentity | undefined,
) => {
  if (desired === undefined) return false;
  const observedType = (observed?.type ?? "None").replace(/\s/g, "");
  if (observedType.toLowerCase() !== desired.type.replace(/\s/g, "").toLowerCase()) {
    return true;
  }
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((key) => key.toLowerCase())
    .sort()
    .join(",");
  const want = (desired.userAssignedIdentityIds ?? [])
    .map((key) => key.toLowerCase())
    .sort()
    .join(",");
  return have !== want;
};

const toIdentityInput = (
  identity: NamespaceIdentity | undefined,
): servicebus.IdentityInput | undefined =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities: identity.userAssignedIdentityIds?.length
          ? Object.fromEntries(identity.userAssignedIdentityIds.map((armId) => [armId, {}]))
          : undefined,
      };

/**
 * ARM rejects a namespace write while a previous operation on it is still
 * running (`Conflict`); short waits converge.
 */
const whileBusy = {
  while: (e: { readonly _tag: string }) => e._tag === "ResourceConflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 12,
} as const;

const isPremium = (sku: string | undefined) => lower(sku) === "premium";

export const NamespaceProvider = () =>
  Provider.succeed(Namespace, {
    stables: [
      "namespaceName",
      "namespaceId",
      "resourceGroup",
      "location",
      "serviceBusEndpoint",
      "hostName",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(servicebus.ListNamespaces, { subscriptionId });
      return (page.value ?? []).flatMap((ns) => {
        const group = resourceGroupOf(ns.id);
        return hasAnyAlchemyTag(ns.tags) && group !== undefined && ns.name !== undefined
          ? [toAttrs(group, ns.name, ns, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && lower(news.name) !== lower(output.namespaceName)) ||
        (news.location !== undefined &&
          lower(news.location)?.replace(/\s/g, "") !==
            lower(output.location)?.replace(/\s/g, "")) ||
        isPremium(news.sku ?? "Standard") !== isPremium(output.sku)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.namespaceName ?? olds?.name ?? (yield* createNamespaceName(id));
      const observed = yield* getNamespace(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        name,
        observed,
        yield* rootConnectionString(subscriptionId, resourceGroup, name, observed),
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceBus");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.namespaceName ?? (yield* createNamespaceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const skuName = news.sku ?? "Standard";
      const sku: servicebus.SBSku = {
        name: skuName,
        tier: skuName,
        capacity: skuName === "Premium" ? (news.capacity ?? 1) : undefined,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        namespaceName: name,
      };
      const label = `service bus namespace ${name}`;
      const get = getNamespace(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(label, get, (ns) => ns.properties?.provisioningState, {
        interval: "5 seconds",
        times: 72,
      });

      // Body for a full PUT: desired values where the user set them, the
      // observed value otherwise, so a PUT never resets settings owned by
      // someone else (e.g. `publicNetworkAccess` set by a NetworkRuleSet).
      const body = (observed: ObservedNamespace | undefined) => {
        const props = observed?.properties;
        return {
          ...where,
          location,
          tags,
          sku,
          identity:
            toIdentityInput(news.identity) ??
            (observed?.identity?.type
              ? toIdentityInput({
                  type: observed.identity.type,
                  userAssignedIdentityIds: Object.keys(
                    observed.identity.userAssignedIdentities ?? {},
                  ),
                })
              : undefined),
          properties: {
            minimumTlsVersion: news.minimumTlsVersion ?? "1.2",
            disableLocalAuth: news.disableLocalAuth ?? props?.disableLocalAuth ?? false,
            publicNetworkAccess: news.publicNetworkAccess ?? props?.publicNetworkAccess,
            ipAddressType: news.ipAddressType ?? props?.ipAddressType,
            zoneRedundant: news.zoneRedundant ?? props?.zoneRedundant,
            premiumMessagingPartitions:
              skuName === "Premium"
                ? (news.premiumMessagingPartitions ?? props?.premiumMessagingPartitions)
                : undefined,
          },
        } satisfies servicebus.NamespacesCreateOrUpdateRequest;
      };

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* servicebus.NamespacesCreateOrUpdate(body(undefined)).pipe(Effect.retry(whileBusy));
      }
      observed = yield* waitReady;

      // Sync sku, settings, identity, and tags against observed state.
      const props = observed.properties ?? {};
      const desired = body(observed);
      const changed =
        lower(observed.sku?.name) !== lower(skuName) ||
        (skuName === "Premium" && observed.sku?.capacity !== sku.capacity) ||
        props.minimumTlsVersion !== desired.properties.minimumTlsVersion ||
        (props.disableLocalAuth ?? false) !== desired.properties.disableLocalAuth ||
        (news.publicNetworkAccess !== undefined &&
          lower(props.publicNetworkAccess) !== lower(news.publicNetworkAccess)) ||
        (news.ipAddressType !== undefined &&
          lower(props.ipAddressType) !== lower(news.ipAddressType)) ||
        identityDiffers(observed.identity, news.identity) ||
        tagsDiffer(observed.tags, tags);
      if (changed) {
        yield* servicebus.NamespacesCreateOrUpdate(desired).pipe(Effect.retry(whileBusy));
        observed = yield* waitReady;
      }

      return toAttrs(
        resourceGroup,
        name,
        observed,
        yield* rootConnectionString(subscriptionId, resourceGroup, name, observed),
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        servicebus
          .DeleteNamespace({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            namespaceName: output.namespaceName,
          })
          .pipe(Effect.retry(whileBusy)),
      );
      yield* waitUntilGone(
        `service bus namespace ${output.namespaceName}`,
        getNamespace(subscriptionId, output.resourceGroup, output.namespaceName),
        { interval: "5 seconds", times: 72 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
