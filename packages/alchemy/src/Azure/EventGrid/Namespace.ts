import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
  createEventGridName,
  identityDiffers,
  ipRulesDiffer,
  redactKeys,
  sameName,
  setIfChanged,
  toIdentityInfo,
  toIpRules,
  type EventGridIdentity,
  type EventGridInboundIpRule,
} from "./common.ts";

/** MQTT broker settings of a namespace. */
export interface NamespaceTopicSpacesConfiguration {
  /**
   * Whether the MQTT broker is enabled. Azure does not allow disabling it
   * once enabled, so switching to `Disabled` replaces the namespace.
   */
  state: "Enabled" | "Disabled";
  /**
   * ARM ID of a namespace topic that receives routed MQTT messages.
   */
  routeTopicResourceId?: string;
  /**
   * Maximum session expiry in hours (1-8).
   * @default Azure's default (`1`)
   */
  maximumSessionExpiryInHours?: number;
  /**
   * Maximum number of sessions per authentication name (1-100).
   * @default Azure's default (`1`)
   */
  maximumClientSessionsPerAuthenticationName?: number;
}

export interface NamespaceProps {
  /** Resource group the namespace is created in. Changing it replaces the namespace. */
  resourceGroup: string;
  /**
   * Namespace name: 3-50 letters, digits, and hyphens, unique per region.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the namespace.
   */
  name?: string;
  /**
   * Azure location of the namespace. Changing it replaces the namespace.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Throughput units of the `Standard` SKU (1-40). Each unit is billed
   * hourly.
   * @default 1
   */
  capacity?: number;
  /**
   * Spread the namespace across availability zones. Changing it replaces
   * the namespace.
   * @default Azure's default for the region
   */
  isZoneRedundant?: boolean;
  /** MQTT broker settings. Omit to leave the broker disabled. */
  topicSpacesConfiguration?: NamespaceTopicSpacesConfiguration;
  /**
   * Whether the public endpoints accept traffic.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * IP ranges allowed to connect while `publicNetworkAccess` is `Enabled`.
   * An empty list (the default) allows every address.
   * @default []
   */
  inboundIpRules?: EventGridInboundIpRule[];
  /** Managed identity of the namespace. */
  identity?: EventGridIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Namespace extends Resource<
  "Azure.EventGrid.Namespace",
  NamespaceProps,
  {
    /** Name of the namespace. */
    namespaceName: string;
    /** ARM resource ID of the namespace. */
    namespaceId: string;
    /** Resource group that holds the namespace. */
    resourceGroup: string;
    /** Location of the namespace. */
    location: string;
    /** Throughput units. */
    capacity: number;
    /** Whether the namespace is zone redundant. */
    isZoneRedundant: boolean | undefined;
    /** Whether the MQTT broker is enabled. */
    topicSpacesEnabled: boolean;
    /** Hostname for publishing to and receiving from namespace topics. */
    topicsHostname: string | undefined;
    /** MQTT broker hostname (when the broker is enabled). */
    topicSpacesHostname: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Primary SAS key. */
    primaryKey: Redacted.Redacted<string> | undefined;
    /** Secondary SAS key. */
    secondaryKey: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Event Grid namespace — hosts namespace topics with pull or push
 * delivery of CloudEvents, and optionally an MQTT broker. Billed per
 * throughput unit hour.
 *
 * @see https://learn.microsoft.com/azure/event-grid/concepts-event-grid-namespaces
 *
 * ### Creating a Namespace
 * **Example:** Namespace with one throughput unit
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const namespace = yield* Azure.EventGrid.Namespace("events", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * ### MQTT Broker
 * **Example:** Namespace with the MQTT broker enabled
 * ```typescript
 * const namespace = yield* Azure.EventGrid.Namespace("iot", {
 *   resourceGroup: group.resourceGroupName,
 *   capacity: 2,
 *   topicSpacesConfiguration: { state: "Enabled" },
 * });
 * ```
 *
 * @resource
 */
export const Namespace = Resource<Namespace>("Azure.EventGrid.Namespace");

type ObservedNamespace = Pick<
  eventgrid.Namespace,
  "id" | "location" | "properties" | "identity" | "tags" | "sku"
>;

const getNamespace = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetNamespace({
      subscriptionId,
      resourceGroupName,
      namespaceName,
    }),
  );

const listKeys = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.ListNamespaceSharedAccessKeys({
      subscriptionId,
      resourceGroupName,
      namespaceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  namespace: ObservedNamespace,
  keys: { key1?: string; key2?: string } | undefined,
): Namespace["Attributes"] => ({
  namespaceName: name,
  namespaceId: namespace.id ?? "",
  resourceGroup,
  location: namespace.location,
  capacity: namespace.sku?.capacity ?? 1,
  isZoneRedundant: namespace.properties?.isZoneRedundant,
  topicSpacesEnabled:
    namespace.properties?.topicSpacesConfiguration?.state === "Enabled",
  topicsHostname: namespace.properties?.topicsConfiguration?.hostname,
  topicSpacesHostname: namespace.properties?.topicSpacesConfiguration?.hostname,
  principalId: namespace.identity?.principalId,
  ...redactKeys(keys),
  tags: userTags(namespace.tags),
});

/** Namespaces report `CreateFailed`/`UpdatedFailed`; treat them as `Failed`. */
const provisioned = (namespace: ObservedNamespace) => {
  const state = namespace.properties?.provisioningState;
  return state?.endsWith("Failed") ? "Failed" : state;
};

export const NamespaceProvider = () =>
  Provider.succeed(Namespace, {
    stables: ["namespaceName", "namespaceId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* eventgrid
        .ListNamespaceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListNamespaceBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((namespace) => {
        const group = resourceGroupOf(namespace.id);
        return hasAnyAlchemyTag(namespace.tags) &&
          group !== undefined &&
          namespace.name !== undefined
          ? [toAttrs(group, namespace.name, namespace, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.namespaceName) ||
        (news.location !== undefined &&
          !sameName(news.location, output.location)) ||
        (news.isZoneRedundant !== undefined &&
          output.isZoneRedundant !== undefined &&
          news.isZoneRedundant !== output.isZoneRedundant) ||
        (output.topicSpacesEnabled &&
          news.topicSpacesConfiguration?.state !== "Enabled")
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
        output?.namespaceName ??
        olds?.name ??
        (yield* createEventGridName(id, 50));
      const observed = yield* getNamespace(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const keys = yield* listKeys(subscriptionId, resourceGroup, name);
      const attrs = toAttrs(resourceGroup, name, observed, keys);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.namespaceName ??
        (yield* createEventGridName(id, 50));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identity = toIdentityInfo(news.identity);
      const inboundIpRules = toIpRules(news.inboundIpRules);
      const capacity = news.capacity ?? 1;
      const topicSpaces = news.topicSpacesConfiguration;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        namespaceName: name,
      };
      const get = getNamespace(subscriptionId, resourceGroup, name);
      const label = `event grid namespace ${name}`;
      const budget = { interval: "5 seconds", times: 72 } as const;

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation (1-3 minutes).
      if (observed === undefined) {
        yield* eventgrid.NamespacesCreateOrUpdate({
          ...where,
          location,
          tags,
          identity,
          sku: { name: "Standard", capacity },
          properties: {
            isZoneRedundant: news.isZoneRedundant,
            publicNetworkAccess: news.publicNetworkAccess,
            inboundIpRules,
            topicSpacesConfiguration: topicSpaces,
          },
        });
      }
      observed = yield* waitForProvisioned(label, get, provisioned, budget);

      // Sync mutable aspects against observed state; PATCH only the delta.
      const props = observed.properties ?? {};
      const changed: eventgrid.NamespaceUpdateParameterProperties = {};
      setIfChanged(
        changed,
        "publicNetworkAccess",
        news.publicNetworkAccess,
        props.publicNetworkAccess,
      );
      if (ipRulesDiffer(props.inboundIpRules, inboundIpRules)) {
        changed.inboundIpRules = inboundIpRules;
      }
      if (topicSpaces !== undefined) {
        const have = props.topicSpacesConfiguration ?? {};
        const delta: eventgrid.UpdateTopicSpacesConfigurationInfo = {};
        setIfChanged(
          delta,
          "state",
          topicSpaces.state,
          have.state ?? "Disabled",
        );
        setIfChanged(
          delta,
          "routeTopicResourceId",
          topicSpaces.routeTopicResourceId,
          have.routeTopicResourceId,
        );
        setIfChanged(
          delta,
          "maximumSessionExpiryInHours",
          topicSpaces.maximumSessionExpiryInHours,
          have.maximumSessionExpiryInHours,
        );
        setIfChanged(
          delta,
          "maximumClientSessionsPerAuthenticationName",
          topicSpaces.maximumClientSessionsPerAuthenticationName,
          have.maximumClientSessionsPerAuthenticationName,
        );
        if (Object.keys(delta).length > 0) {
          changed.topicSpacesConfiguration = {
            ...delta,
            state: topicSpaces.state,
          };
        }
      }
      const skuChanged = (observed.sku?.capacity ?? 1) !== capacity;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const identityChanged = identityDiffers(observed.identity, news.identity);
      if (
        Object.keys(changed).length > 0 ||
        skuChanged ||
        tagsChanged ||
        identityChanged
      ) {
        yield* eventgrid.UpdateNamespace({
          ...where,
          sku: skuChanged ? { name: "Standard", capacity } : undefined,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged ? identity : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
        observed = yield* waitForProvisioned(label, get, provisioned, budget);
      }

      const keys = yield* listKeys(subscriptionId, resourceGroup, name);
      return toAttrs(resourceGroup, name, observed, keys);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeleteNamespace({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespaceName,
        }),
      );
      yield* waitUntilGone(
        `event grid namespace ${output.namespaceName}`,
        getNamespace(
          subscriptionId,
          output.resourceGroup,
          output.namespaceName,
        ).pipe(
          Effect.map((namespace) =>
            namespace?.properties?.provisioningState === "Deleted"
              ? undefined
              : namespace,
          ),
        ),
        { interval: "5 seconds", times: 72 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
