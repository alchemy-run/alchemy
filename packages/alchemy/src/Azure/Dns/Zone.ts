import * as dns from "@distilled.cloud/azure/dns";
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
  DNS_BUDGET,
  GLOBAL,
  hasAnyMarker,
  ownsMetadata,
  sameArm,
  sameMap,
  userMetadata,
} from "./Common.ts";

export interface ZoneProps {
  /**
   * Resource group the zone is created in. Changing it replaces the zone.
   */
  resourceGroup: string;
  /**
   * DNS name of the zone without a terminating dot, e.g. `contoso.com`.
   * If omitted, `<generated-name>.com` is used, where the generated name
   * comes from the app, stage, and logical ID. Creating a zone requires no
   * proof of domain ownership; the zone only answers queries once the
   * domain's registrar delegates to `nameServers`. Changing it replaces the
   * zone.
   */
  name?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy_stack`, `alchemy_stage`,
   * `alchemy_id`) are merged in automatically; Azure DNS drops tag keys
   * containing `:`.
   */
  tags?: Record<string, string>;
}

export interface Zone extends Resource<
  "Azure.Dns.Zone",
  ZoneProps,
  {
    /** DNS name of the zone (without a terminating dot). */
    zoneName: string;
    /** ARM resource ID of the zone. */
    zoneId: string;
    /** Resource group that holds the zone. */
    resourceGroup: string;
    /**
     * The Azure name servers that serve the zone. Delegate the domain to
     * these at its registrar (or in the parent zone).
     */
    nameServers: string[];
    /** Current number of record sets in the zone (including SOA and NS). */
    numberOfRecordSets: number | undefined;
    /** Maximum number of record sets the zone can hold. */
    maxNumberOfRecordSets: number | undefined;
    /** Maximum number of records per record set. */
    maxNumberOfRecordsPerRecordSet: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure public DNS zone — hosts the DNS records of a domain on Azure's
 * global anycast name servers.
 *
 * Add records with `Azure.Dns.RecordSet`, then delegate the domain to the
 * zone's `nameServers` at its registrar. Zones are global resources. For
 * zones resolvable only from virtual networks use `Azure.PrivateDns.Zone`.
 *
 * @see https://learn.microsoft.com/azure/dns/dns-zones-records
 *
 * ### Creating a Zone
 * **Example:** Zone for a domain
 * ```typescript
 * const zone = yield* Azure.Dns.Zone("contoso", {
 *   resourceGroup: group.resourceGroupName,
 *   name: "contoso.com",
 *   tags: { team: "web" },
 * });
 * // delegate contoso.com to these at the registrar
 * const nameServers = zone.nameServers;
 * ```
 *
 * ### Adding Records
 * **Example:** A record at the zone apex
 * ```typescript
 * yield* Azure.Dns.RecordSet("apex", {
 *   resourceGroup: group.resourceGroupName,
 *   zoneName: zone.zoneName,
 *   recordType: "A",
 *   name: "@",
 *   aRecords: ["203.0.113.10"],
 * });
 * ```
 *
 * @resource
 */
export const Zone = Resource<Zone>("Azure.Dns.Zone");

/** Default zone name: a generated label under `.com`. */
export const createZoneName = Effect.fn(function* (id: string) {
  const label = yield* createPhysicalName({
    id,
    maxLength: 63,
    lowercase: true,
  });
  return `${label.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "")}.com`;
});

const getZone = (
  subscriptionId: string,
  resourceGroupName: string,
  zoneName: string,
) =>
  orUndefinedIfNotFound(
    dns.GetZone({ subscriptionId, resourceGroupName, zoneName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  zone: dns.GetZoneResponse | dns.Zone,
): Zone["Attributes"] => ({
  zoneName: name,
  zoneId: zone.id ?? "",
  resourceGroup,
  nameServers: [...(zone.properties?.nameServers ?? [])],
  numberOfRecordSets: zone.properties?.numberOfRecordSets,
  maxNumberOfRecordSets: zone.properties?.maxNumberOfRecordSets,
  maxNumberOfRecordsPerRecordSet:
    zone.properties?.maxNumberOfRecordsPerRecordSet,
  tags: userMetadata(zone.tags),
});

export const ZoneProvider = () =>
  Provider.succeed(Zone, {
    stables: ["zoneName", "zoneId", "resourceGroup", "nameServers"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* dns
        .ListZones({ subscriptionId })
        .pipe(Effect.flatMap((page) => requireSinglePage("ListZones", page)));
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
        (news.name !== undefined && !sameArm(news.name, output.zoneName))
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
        output?.zoneName ?? olds?.name ?? (yield* createZoneName(id));
      const observed = yield* getZone(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* ownsMetadata(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.zoneName ?? (yield* createZoneName(id));
      const tags = yield* desiredMetadata(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        zoneName: name,
      };
      const get = getZone(subscriptionId, resourceGroup, name);
      const label = `DNS zone ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure: zone PUT is synchronous.
      if (observed === undefined) {
        yield* dns.ZonesCreateOrUpdate({
          ...where,
          location: GLOBAL,
          tags,
          properties: { zoneType: "Public" },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        () => undefined,
        DNS_BUDGET,
      );

      // Sync tags against observed state.
      if (!sameMap(observed.tags, tags)) {
        yield* dns.UpdateZone({ ...where, tags });
        observed = yield* waitForProvisioned(
          label,
          get,
          (zone) => (sameMap(zone.tags, tags) ? undefined : "Updating"),
          DNS_BUDGET,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        dns.DeleteZone({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          zoneName: output.zoneName,
        }),
      );
      yield* waitUntilGone(
        `DNS zone ${output.zoneName}`,
        getZone(subscriptionId, output.resourceGroup, output.zoneName),
        DNS_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
