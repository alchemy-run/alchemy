import * as peering from "@distilled.cloud/azure/peering";
import * as Effect from "effect/Effect";
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
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createPeeringName, getPeering } from "./Common.ts";

export type PeeringKind = "Direct" | "Exchange";

export type PeeringSkuName =
  | "Basic_Exchange_Free"
  | "Basic_Direct_Free"
  | "Premium_Direct_Free"
  | "Premium_Direct_Metered"
  | "Premium_Direct_Unlimited";

/** Properties of a Direct peering. */
export interface DirectPeeringProps {
  /** ARM resource ID of the approved `Azure.Peering.PeerAsn`. */
  peerAsnId: string;
  /** Type of the direct peering (`Edge`, `Transit`, `Cdn`, `Ix`, ...). */
  directPeeringType: peering.DirectPeeringType;
  /** Physical connections of the peering at the peering facility. */
  connections: peering.DirectConnectionInput[];
}

/** Properties of an Exchange peering. */
export interface ExchangePeeringProps {
  /** ARM resource ID of the approved `Azure.Peering.PeerAsn`. */
  peerAsnId: string;
  /** BGP sessions with Microsoft at the Internet exchange. */
  connections: peering.ExchangeConnectionInput[];
}

export interface PeeringProps {
  /** Resource group the peering is created in. Changing it replaces the peering. */
  resourceGroup: string;
  /**
   * Name of the peering. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the peering.
   */
  name?: string;
  /**
   * Azure location of the ARM resource. Changing it replaces the peering.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Kind of peering. Changing it replaces the peering. */
  kind: PeeringKind;
  /** SKU of the peering; must match `kind`. Changing it replaces the peering. */
  sku: PeeringSkuName;
  /**
   * Peering location (metro) as returned by `ListPeeringLocations`, e.g.
   * `Seattle`. Changing it replaces the peering.
   */
  peeringLocation: string;
  /** Direct peering settings; required when `kind` is `Direct`. */
  direct?: DirectPeeringProps;
  /** Exchange peering settings; required when `kind` is `Exchange`. */
  exchange?: ExchangePeeringProps;
  /** Connectivity probes Microsoft runs against the peer's network. */
  connectivityProbes?: peering.ConnectivityProbeInput[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Peering extends Resource<
  "Azure.Peering.Peering",
  PeeringProps,
  {
    /** Name of the peering. */
    peeringName: string;
    /** Resource group that holds the peering. */
    resourceGroup: string;
    /** ARM resource ID of the peering. */
    peeringId: string;
    /** Location of the ARM resource. */
    location: string;
    /** Kind of peering. */
    kind: string;
    /** SKU name of the peering. */
    sku: string;
    /** Peering location (metro). */
    peeringLocation: string;
    /** Observed direct peering, including connection and BGP session states. */
    direct: peering.PeeringPropertiesDirect | undefined;
    /** Observed exchange peering, including connection and BGP session states. */
    exchange: peering.PeeringPropertiesExchange | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Direct or Exchange peering between a network operator and Microsoft
 * (AS8075). Requires a `PeerAsn` that Microsoft has approved for the
 * subscription and physical presence at the peering facility; otherwise
 * Azure rejects the peering with `PeeringPeerAsnNotApproved`.
 *
 * @see https://learn.microsoft.com/azure/internet-peering/overview
 *
 * ### Creating a Peering
 * **Example:** Exchange peering at an Internet exchange
 * ```typescript
 * const peering = yield* Azure.Peering.Peering("seattle-ix", {
 *   resourceGroup: group.resourceGroupName,
 *   kind: "Exchange",
 *   sku: "Basic_Exchange_Free",
 *   peeringLocation: "Seattle",
 *   exchange: {
 *     peerAsnId: asn.peerAsnId,
 *     connections: [
 *       {
 *         peeringDBFacilityId: 26,
 *         bgpSession: {
 *           peerSessionIPv4Address: "198.32.134.10",
 *           maxPrefixesAdvertisedV4: 1000,
 *         },
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * **Example:** Direct peering
 * ```typescript
 * const peering = yield* Azure.Peering.Peering("ashburn-direct", {
 *   resourceGroup: group.resourceGroupName,
 *   kind: "Direct",
 *   sku: "Basic_Direct_Free",
 *   peeringLocation: "Ashburn",
 *   direct: {
 *     peerAsnId: asn.peerAsnId,
 *     directPeeringType: "Edge",
 *     connections: [
 *       {
 *         bandwidthInMbps: 10000,
 *         sessionAddressProvider: "Peer",
 *         peeringDBFacilityId: 99999,
 *         connectionIdentifier: "conn-1",
 *         bgpSession: {
 *           sessionPrefixV4: "192.0.2.0/31",
 *           maxPrefixesAdvertisedV4: 1000,
 *         },
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Peering = Resource<Peering>("Azure.Peering.Peering");

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: peering.GetPeeringResponse,
): Peering["Attributes"] => ({
  peeringName: name,
  resourceGroup,
  peeringId: observed.id ?? "",
  location: observed.location,
  kind: observed.kind,
  sku: observed.sku.name ?? "",
  peeringLocation: observed.properties?.peeringLocation ?? "",
  direct: observed.properties?.direct,
  exchange: observed.properties?.exchange,
  provisioningState: observed.properties?.provisioningState,
  tags: userTags(observed.tags),
});

/**
 * Whether every value set in `desired` is present in `observed` (arrays
 * must have the same length). Observed connections carry extra read-only
 * state, so only the desired keys are compared.
 */
const contains = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((item, i) => contains(item, observed[i]))
    );
  }
  if (typeof desired === "object" && desired !== null) {
    if (typeof observed !== "object" || observed === null) return false;
    return Object.entries(desired).every(([key, value]) =>
      contains(value, (observed as Record<string, unknown>)[key]),
    );
  }
  return typeof desired === "string" && typeof observed === "string"
    ? desired.toLowerCase() === observed.toLowerCase()
    : desired === observed;
};

const toInput = (news: PeeringProps): peering.PeeringPropertiesInput => ({
  peeringLocation: news.peeringLocation,
  direct:
    news.direct === undefined
      ? undefined
      : {
          peerAsn: { id: news.direct.peerAsnId },
          directPeeringType: news.direct.directPeeringType,
          connections: news.direct.connections,
        },
  exchange:
    news.exchange === undefined
      ? undefined
      : {
          peerAsn: { id: news.exchange.peerAsnId },
          connections: news.exchange.connections,
        },
  connectivityProbes: news.connectivityProbes,
});

export const PeeringProvider = () =>
  Provider.succeed(Peering, {
    stables: ["peeringName", "resourceGroup", "peeringId", "kind"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* peering
        .ListPeeringBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPeeringBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((item) => {
        const group = resourceGroupOf(item.id);
        return hasAnyAlchemyTag(item.tags) &&
          group !== undefined &&
          item.name !== undefined
          ? [toAttrs(group, item.name, item)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.peeringName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase()) ||
        news.kind !== output.kind ||
        news.sku.toLowerCase() !== output.sku.toLowerCase() ||
        news.peeringLocation.toLowerCase() !==
          output.peeringLocation.toLowerCase()
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
        output?.peeringName ?? olds?.name ?? (yield* createPeeringName(id));
      const observed = yield* getPeering(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Peering");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.peeringName ?? (yield* createPeeringName(id));
      const tags = yield* desiredTags(id, news.tags);
      const desired = toInput(news);
      const get = getPeering(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync connections/probes: the PUT is a long-running upsert,
      // sent only when the peering is missing or its connections drifted.
      if (
        observed === undefined ||
        !contains(
          {
            direct: desired.direct,
            exchange: desired.exchange,
            connectivityProbes: desired.connectivityProbes,
          },
          observed.properties,
        )
      ) {
        yield* peering.PeeringsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          peeringName: name,
          location: observed?.location ?? news.location ?? env.location,
          kind: observed?.kind ?? news.kind,
          sku: observed?.sku ?? { name: news.sku },
          properties: desired,
          tags,
        });
      } else if (tagsDiffer(observed.tags, tags)) {
        // Sync tags.
        yield* peering.UpdatePeering({
          subscriptionId,
          resourceGroupName: resourceGroup,
          peeringName: name,
          tags,
        });
      }

      const fresh = yield* waitForProvisioned(
        `peering ${name}`,
        get,
        (item) => item.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        peering.DeletePeering({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          peeringName: output.peeringName,
        }),
      );
      yield* waitUntilGone(
        `peering ${output.peeringName}`,
        getPeering(subscriptionId, output.resourceGroup, output.peeringName),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
