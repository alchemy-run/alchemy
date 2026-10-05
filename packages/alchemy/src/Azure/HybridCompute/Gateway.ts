import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
import * as Effect from "effect/Effect";
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

export interface GatewayProps {
  /**
   * Resource group the gateway is created in. Changing it replaces the
   * gateway.
   */
  resourceGroup: string;
  /**
   * Name of the gateway. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the gateway.
   */
  name?: string;
  /**
   * Azure location of the gateway. Changing it replaces the gateway.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Features routed through the gateway. `["*"]` enables every feature.
   * @default ["*"]
   */
  allowedFeatures?: string[];
  /**
   * DNS hostnames that bypass the gateway and are reached directly.
   * @default []
   */
  gatewayBypass?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Gateway extends Resource<
  "Azure.HybridCompute.Gateway",
  GatewayProps,
  {
    /** Name of the gateway. */
    gatewayName: string;
    /** Resource group that holds the gateway. */
    resourceGroup: string;
    /**
     * ARM resource ID of the gateway, used by `azcmagent connect
     * --gateway-id` and by `HybridCompute.Settings`.
     */
    gatewayResourceId: string;
    /** Immutable unique identifier of the gateway. */
    gatewayId: string | undefined;
    /** FQDN Arc agents send their traffic to. */
    gatewayEndpoint: string | undefined;
    /** Type of the gateway (`Public`). */
    gatewayType: string | undefined;
    /** Location of the gateway. */
    location: string;
    /** Features routed through the gateway. */
    allowedFeatures: string[];
    /** DNS hostnames that bypass the gateway. */
    gatewayBypass: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Arc gateway — a single public egress endpoint Arc-enabled
 * servers route their Azure Arc traffic through, so firewalls only need to
 * allow a handful of URLs.
 *
 * Provisioning takes 5-25 minutes, and a subscription holds at most five
 * gateways.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/servers/arc-gateway
 *
 * ### Creating a Gateway
 * **Example:** Gateway for all Arc features
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("arc");
 * const gateway = yield* Azure.HybridCompute.Gateway("arc-gateway", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Let some hosts bypass the gateway
 * ```typescript
 * const gateway = yield* Azure.HybridCompute.Gateway("arc-gateway", {
 *   resourceGroup: group.resourceGroupName,
 *   gatewayBypass: ["packages.example.com"],
 * });
 * ```
 *
 * ### Associating Machines
 * **Example:** Route an Arc machine through the gateway
 * ```typescript
 * yield* Azure.HybridCompute.Settings("machine-gateway", {
 *   resourceGroup: group.resourceGroupName,
 *   machineName: "my-server",
 *   gatewayResourceId: gateway.gatewayResourceId,
 * });
 * ```
 *
 * @resource
 */
export const Gateway = Resource<Gateway>("Azure.HybridCompute.Gateway");

type ObservedGateway = hybridcompute.GetGatewayResponse;

const getGateway = (
  subscriptionId: string,
  resourceGroupName: string,
  gatewayName: string,
) =>
  orUndefinedIfNotFound(
    hybridcompute.GetGateway({
      subscriptionId,
      resourceGroupName,
      gatewayName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  gateway: ObservedGateway,
): Gateway["Attributes"] => ({
  gatewayName: name,
  resourceGroup,
  gatewayResourceId: gateway.id ?? "",
  gatewayId: gateway.properties?.gatewayId,
  gatewayEndpoint: gateway.properties?.gatewayEndpoint,
  gatewayType: gateway.properties?.gatewayType,
  location: gateway.location,
  allowedFeatures: [...(gateway.properties?.allowedFeatures ?? [])],
  gatewayBypass: [...(gateway.properties?.gatewayBypass ?? [])],
  tags: userTags(gateway.tags),
});

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const left = a.map((x) => x.toLowerCase()).sort();
  const right = b.map((x) => x.toLowerCase()).sort();
  return left.length === right.length && left.every((x, i) => x === right[i]);
};

// Azure rejects gateway names longer than 54 characters.
const nameOf = (id: string) => createPhysicalName({ id, maxLength: 54 });

// Gateways take 5-25 minutes to provision.
const budget = { interval: "30 seconds", times: 60 } as const;

/** Writes and deletes are rejected while the gateway is provisioning. */
const retryTransitioning = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "HybridComputeGatewayTransitioning",
      schedule: Schedule.spaced("30 seconds"),
      times: 60,
    }),
  );

export const GatewayProvider = () =>
  Provider.succeed(Gateway, {
    stables: [
      "gatewayName",
      "resourceGroup",
      "gatewayResourceId",
      "gatewayId",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* hybridcompute
        .ListGatewayBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListGatewayBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((gateway) => {
        const group = resourceGroupOf(gateway.id);
        return hasAnyAlchemyTag(gateway.tags) &&
          group !== undefined &&
          gateway.name !== undefined
          ? [toAttrs(group, gateway.name, gateway)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.gatewayName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.gatewayName ?? olds?.name ?? (yield* nameOf(id));
      const observed = yield* getGateway(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.HybridCompute");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.gatewayName ?? (yield* nameOf(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const allowedFeatures = news.allowedFeatures ?? ["*"];
      const gatewayBypass = news.gatewayBypass ?? [];
      const label = `gateway ${name}`;
      const get = getGateway(subscriptionId, resourceGroup, name);
      const provisioned = waitForProvisioned(
        label,
        get,
        (gateway) => gateway.properties?.provisioningState,
        budget,
      );

      // Observe.
      let observed = yield* get;

      // Ensure: create when missing (LRO), then wait until usable.
      if (observed === undefined) {
        yield* hybridcompute.GatewaysCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          gatewayName: name,
          location,
          tags,
          properties: { gatewayType: "Public", allowedFeatures, gatewayBypass },
        });
      }
      observed = yield* provisioned;

      // Sync mutable aspects against observed state; PATCH only deltas.
      const featuresDiffer = !sameSet(
        observed.properties?.allowedFeatures ?? [],
        allowedFeatures,
      );
      const bypassDiffer = !sameSet(
        observed.properties?.gatewayBypass ?? [],
        gatewayBypass,
      );
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (featuresDiffer || bypassDiffer || tagsChanged) {
        yield* retryTransitioning(
          hybridcompute.UpdateGateway({
            subscriptionId,
            resourceGroupName: resourceGroup,
            gatewayName: name,
            ...(tagsChanged ? { tags } : {}),
            ...(featuresDiffer || bypassDiffer
              ? {
                  properties: {
                    ...(featuresDiffer ? { allowedFeatures } : {}),
                    ...(bypassDiffer ? { gatewayBypass } : {}),
                  },
                }
              : {}),
          }),
        );
        observed = yield* provisioned;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        retryTransitioning(
          hybridcompute.DeleteGateway({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            gatewayName: output.gatewayName,
          }),
        ),
      );
      yield* waitUntilGone(
        `gateway ${output.gatewayName}`,
        getGateway(subscriptionId, output.resourceGroup, output.gatewayName),
        budget,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
