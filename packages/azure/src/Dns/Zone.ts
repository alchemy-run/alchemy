import * as dns from "@distilled.cloud/azure/dns";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  resourceGroupOf,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
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
   * containing `:`. Changing tags updates the zone in place.
   * @default {}
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
 * An Azure public DNS zone (`Microsoft.Network/dnsZones`): hosts the DNS
 * records of a domain on Azure's global anycast name servers.
 *
 * Add records with `Azure.Dns.RecordSet`, then delegate the domain to the
 * zone's `nameServers` at its registrar. Zones are global resources, so
 * the zone has no region. Alchemy registers the `Microsoft.Network`
 * resource provider on the subscription for you. Creating a zone needs no
 * proof that you own the domain; the zone answers public queries only
 * after the registrar delegates to it. For zones that only virtual
 * networks resolve, use `Azure.PrivateDns.Zone`.
 *
 * :::caution[Changing `name` or `resourceGroup` replaces the zone]
 * Alchemy creates a new zone and deletes the old one with every record set
 * in it. Azure picks the new zone's `nameServers` from its pool, so they
 * can differ from the old ones: update the delegation at the registrar, or
 * the domain stops resolving.
 * :::
 *
 * :::caution[Set `name` for a real domain]
 * If you omit `name`, Alchemy generates `<generated-name>.com`. Nobody
 * delegates that name to your zone, so it never answers public queries.
 * :::
 *
 * @see https://learn.microsoft.com/azure/dns/dns-zones-records
 *
 * ### Creating a Zone
 * Set `name` to the domain you own. `zone.nameServers` lists the four
 * Azure name servers to enter at the registrar.
 *
 * **Example:** Zone for a domain
 * ```typescript
 * const zone = yield* Azure.Dns.Zone("contoso", {
 *   name: "contoso.com",
 *   tags: { team: "web" },
 * });
 * // delegate contoso.com to these at the registrar
 * const nameServers = zone.nameServers;
 * ```
 *
 * **Example:** Export the name servers from the stack
 * ```typescript
 * const zone = yield* Azure.Dns.Zone("contoso", { name: "contoso.com" });
 * return { nameServers: zone.nameServers };
 * ```
 *
 * ### Adding Records
 * Each `Azure.Dns.RecordSet` holds all records of one type under one name.
 * Use `@` for the zone apex.
 *
 * **Example:** A record at the zone apex
 * ```typescript
 * yield* Azure.Dns.RecordSet("apex", {
 *   zoneName: zone.zoneName,
 *   recordType: "A",
 *   name: "@",
 *   aRecords: ["203.0.113.10"],
 * });
 * ```
 *
 * **Example:** Mail records for the domain
 * ```typescript
 * yield* Azure.Dns.RecordSet("mx", {
 *   zoneName: zone.zoneName,
 *   recordType: "MX",
 *   name: "@",
 *   mxRecords: [{ preference: 10, exchange: "contoso-com.mail.protection.outlook.com" }],
 * });
 * yield* Azure.Dns.RecordSet("spf", {
 *   zoneName: zone.zoneName,
 *   recordType: "TXT",
 *   name: "@",
 *   txtRecords: ["v=spf1 include:spf.protection.outlook.com -all"],
 * });
 * ```
 *
 * ### Delegating a Subdomain
 * Create a child zone for the subdomain, then add an `NS` record set in
 * the parent zone that points at the child's name servers.
 *
 * **Example:** `dev.contoso.com` in its own zone
 * ```typescript
 * const parent = yield* Azure.Dns.Zone("contoso", { name: "contoso.com" });
 * const dev = yield* Azure.Dns.Zone("dev", { name: "dev.contoso.com" });
 * yield* Azure.Dns.RecordSet("dev-delegation", {
 *   zoneName: parent.zoneName,
 *   recordType: "NS",
 *   name: "dev",
 *   nsRecords: dev.nameServers,
 * });
 * ```
 *
 * ### Custom Domains for a Web App
 * App Service checks a CNAME to the app and an `asuid.<name>` TXT record
 * that holds `customDomainVerificationId` before it binds the host name.
 *
 * **Example:** `www` for an App Service web app
 * ```typescript
 * const api = yield* Azure.Web.WebApp("Api", { main: "./src/api.ts" });
 * yield* Azure.Dns.RecordSet("www", {
 *   zoneName: zone.zoneName,
 *   recordType: "CNAME",
 *   name: "www",
 *   cname: api.defaultHostName,
 * });
 * yield* Azure.Dns.RecordSet("www-verify", {
 *   zoneName: zone.zoneName,
 *   recordType: "TXT",
 *   name: "asuid.www",
 *   txtRecords: [api.customDomainVerificationId.as<string>()],
 * });
 * ```
 *
 * ### Custom Domains for Front Door
 * Pass `zone.zoneId` as `azureDnsZoneId` on the Front Door custom domain,
 * publish its validation token at `_dnsauth.<name>`, and point the name at
 * the endpoint. Then add `domain.customDomainId` to a route's
 * `customDomainIds`.
 *
 * **Example:** `www` behind Front Door
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("cdn");
 * const endpoint = yield* Azure.Cdn.AfdEndpoint("web", {
 *   profile: profile.profileName,
 * });
 * const domain = yield* Azure.Cdn.AfdCustomDomain("www", {
 *   profile: profile.profileName,
 *   hostName: "www.contoso.com",
 *   azureDnsZoneId: zone.zoneId,
 * });
 * yield* Azure.Dns.RecordSet("www-dnsauth", {
 *   zoneName: zone.zoneName,
 *   recordType: "TXT",
 *   name: "_dnsauth.www",
 *   txtRecords: [domain.validationToken.as<string>()],
 * });
 * yield* Azure.Dns.RecordSet("www", {
 *   zoneName: zone.zoneName,
 *   recordType: "CNAME",
 *   name: "www",
 *   cname: endpoint.hostName,
 * });
 * ```
 *
 * ### Zone Limits
 * `maxNumberOfRecordSets` and `maxNumberOfRecordsPerRecordSet` report the
 * zone's limits; `numberOfRecordSets` counts the record sets in use,
 * including the `SOA` and apex `NS` record sets Azure creates.
 *
 * **Example:** Export the record-set usage
 * ```typescript
 * const zone = yield* Azure.Dns.Zone("contoso", { name: "contoso.com" });
 * return {
 *   used: zone.numberOfRecordSets,
 *   limit: zone.maxNumberOfRecordSets,
 * };
 * ```
 *
 * @resource
 */
export const Zone = GroupedResource<Zone>("Azure.Dns.Zone");

/** Default zone name: a generated label under `.com`. */
export const createZoneName = Effect.fn(function* (id: string) {
  const label = yield* createPhysicalName({
    id,
    maxLength: 63,
    lowercase: true,
  });
  return `${label.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "")}.com`;
});

const getZone = (subscriptionId: string, resourceGroupName: string, zoneName: string) =>
  orUndefinedIfNotFound(dns.GetZone({ subscriptionId, resourceGroupName, zoneName }));

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
  maxNumberOfRecordsPerRecordSet: zone.properties?.maxNumberOfRecordsPerRecordSet,
  tags: userMetadata(zone.tags),
});

export const ZoneProvider = () =>
  Provider.succeed(Zone, {
    stables: ["zoneName", "zoneId", "resourceGroup", "nameServers"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(dns.ListZones, { subscriptionId });
      return (page.value ?? []).flatMap((zone) => {
        const group = resourceGroupOf(zone.id);
        return hasAnyMarker(zone.tags) && group !== undefined && zone.name !== undefined
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
      const name = output?.zoneName ?? olds?.name ?? (yield* createZoneName(id));
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
      observed = yield* waitForProvisioned(label, get, () => undefined, DNS_BUDGET);

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
