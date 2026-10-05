import * as privatedns from "@distilled.cloud/azure/privatedns";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  desiredMetadata,
  GLOBAL,
  hasAnyMarker,
  ownsMetadata,
  PRIVATE_DNS_BUDGET,
  sameArm,
  sameMap,
  userMetadata,
  whileLinksExist,
} from "./Common.ts";

export interface ZoneProps {
  /**
   * Resource group the zone is created in. Changing it replaces the zone.
   */
  resourceGroup: string;
  /**
   * DNS name of the zone without a terminating dot, e.g.
   * `internal.contoso.com` or `privatelink.blob.core.windows.net`. If
   * omitted, `<generated-name>.internal` is used, where the generated name
   * comes from the app, stage, and logical ID. Changing it replaces the zone.
   */
  name?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy_stack`, `alchemy_stage`,
   * `alchemy_id`) are merged in automatically; Private DNS drops tag keys
   * containing `:`.
   */
  tags?: Record<string, string>;
}

export interface Zone extends Resource<
  "Azure.PrivateDns.Zone",
  ZoneProps,
  {
    /** DNS name of the zone (without a terminating dot). */
    privateZoneName: string;
    /** ARM resource ID of the zone. */
    privateZoneId: string;
    /** Resource group that holds the zone. */
    resourceGroup: string;
    /** Internal ID Azure assigns to the zone. */
    internalId: string | undefined;
    /** Current number of record sets in the zone (including SOA). */
    numberOfRecordSets: number | undefined;
    /** Maximum number of record sets the zone can hold. */
    maxNumberOfRecordSets: number | undefined;
    /** Current number of virtual networks linked to the zone. */
    numberOfVirtualNetworkLinks: number | undefined;
    /** Current number of registration-enabled virtual network links. */
    numberOfVirtualNetworkLinksWithRegistration: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Private DNS zone — a DNS zone resolvable only from the virtual
 * networks linked to it.
 *
 * Add records with `Azure.PrivateDns.RecordSet` and link virtual networks
 * with `Azure.PrivateDns.VirtualNetworkLink`. Zones are global resources.
 *
 * @see https://learn.microsoft.com/azure/dns/private-dns-privatednszone
 *
 * ### Creating a Zone
 * **Example:** Internal zone
 * ```typescript
 * const zone = yield* Azure.PrivateDns.Zone("internal", {
 *   resourceGroup: group.resourceGroupName,
 *   name: "internal.contoso.com",
 * });
 * ```
 *
 * **Example:** Private Link zone for blob storage
 * ```typescript
 * const zone = yield* Azure.PrivateDns.Zone("blob", {
 *   resourceGroup: group.resourceGroupName,
 *   name: "privatelink.blob.core.windows.net",
 *   tags: { purpose: "private-endpoints" },
 * });
 * ```
 *
 * ### Linking a Virtual Network
 * **Example:** Resolve the zone from a virtual network
 * ```typescript
 * yield* Azure.PrivateDns.VirtualNetworkLink("hub", {
 *   resourceGroup: group.resourceGroupName,
 *   privateZoneName: zone.privateZoneName,
 *   virtualNetworkId: vnet.virtualNetworkId,
 * });
 * ```
 *
 * @resource
 */
export const Zone = Resource<Zone>("Azure.PrivateDns.Zone");

/** Default zone name: a generated label under `.internal`. */
export const createZoneName = Effect.fn(function* (id: string) {
  const label = yield* createPhysicalName({
    id,
    maxLength: 63,
    lowercase: true,
  });
  return `${label.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "")}.internal`;
});

const getZone = (
  subscriptionId: string,
  resourceGroupName: string,
  privateZoneName: string,
) =>
  orUndefinedIfNotFound(
    privatedns.GetPrivateZone({
      subscriptionId,
      resourceGroupName,
      privateZoneName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  zone: privatedns.GetPrivateZoneResponse | privatedns.PrivateZone,
): Zone["Attributes"] => ({
  privateZoneName: name,
  privateZoneId: zone.id ?? "",
  resourceGroup,
  internalId: zone.properties?.internalId,
  numberOfRecordSets: zone.properties?.numberOfRecordSets,
  maxNumberOfRecordSets: zone.properties?.maxNumberOfRecordSets,
  numberOfVirtualNetworkLinks: zone.properties?.numberOfVirtualNetworkLinks,
  numberOfVirtualNetworkLinksWithRegistration:
    zone.properties?.numberOfVirtualNetworkLinksWithRegistration,
  tags: userMetadata(zone.tags),
});

export const ZoneProvider = () =>
  Provider.succeed(Zone, {
    stables: [
      "privateZoneName",
      "privateZoneId",
      "resourceGroup",
      "internalId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* privatedns
        .ListPrivateZones({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListPrivateZones", page)),
        );
      return (page.value ?? []).flatMap((zone) => {
        const group = resourceGroupOf(zone.id);
        return hasAnyMarker(zone.tags) &&
          group !== undefined &&
          zone.name !== undefined
          ? [toAttrs(group, zone.name, zone)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameArm(news.name, output.privateZoneName))
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
        output?.privateZoneName ?? olds?.name ?? (yield* createZoneName(id));
      const observed = yield* getZone(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* ownsMetadata(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.privateZoneName ?? (yield* createZoneName(id));
      const tags = yield* desiredMetadata(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        privateZoneName: name,
      };
      const get = getZone(subscriptionId, resourceGroup, name);
      const label = `private DNS zone ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* privatedns.PrivateZonesCreateOrUpdate({
          ...where,
          location: GLOBAL,
          tags,
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (zone) => zone.properties?.provisioningState,
        PRIVATE_DNS_BUDGET,
      );

      // Sync tags against observed state.
      if (!sameMap(observed.tags, tags)) {
        yield* privatedns.UpdatePrivateZone({ ...where, tags });
        observed = yield* waitForProvisioned(
          label,
          get,
          (zone) =>
            !sameMap(zone.tags, tags)
              ? "Updating"
              : zone.properties?.provisioningState,
          PRIVATE_DNS_BUDGET,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        privatedns
          .DeletePrivateZone({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            privateZoneName: output.privateZoneName,
          })
          .pipe(Effect.retry(whileLinksExist)),
      );
      yield* waitUntilGone(
        `private DNS zone ${output.privateZoneName}`,
        getZone(subscriptionId, output.resourceGroup, output.privateZoneName),
        PRIVATE_DNS_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
