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
  hasAnyMarker,
  ownsMetadata,
  sameArm,
  sameMap,
  userMetadata,
} from "./Common.ts";

/**
 * Record types a record set can hold. The zone's `SOA` record set is
 * created and deleted with the zone and is not managed here.
 */
export type RecordType = "A" | "AAAA" | "CAA" | "CNAME" | "MX" | "NS" | "PTR" | "SRV" | "TXT";

export interface MxRecord {
  /** Preference of this mail exchanger (0-65535); lower values are preferred. */
  preference: number;
  /** Domain name of the mail host. */
  exchange: string;
}

export interface SrvRecord {
  /** Priority of the target host (0-65535); lower values are preferred. */
  priority: number;
  /** Relative weight (0-65535) among targets with the same priority. */
  weight: number;
  /** Port the service listens on (0-65535). */
  port: number;
  /** Domain name of the target host. */
  target: string;
}

export interface CaaRecord {
  /** Flags, an integer between 0 and 255 (128 = critical). */
  flags: number;
  /** Property tag, e.g. `issue`, `issuewild`, or `iodef`. */
  tag: string;
  /** Property value, e.g. `letsencrypt.org`. */
  value: string;
}

/** The records of a record set, by type. Only the field for `recordType` is used. */
export interface Records {
  /** IPv4 addresses (`A` record sets). */
  aRecords?: string[];
  /** IPv6 addresses (`AAAA` record sets). */
  aaaaRecords?: string[];
  /** Certification authority authorizations (`CAA` record sets). */
  caaRecords?: CaaRecord[];
  /** Canonical name (`CNAME` record sets hold exactly one). */
  cname?: string;
  /** Mail exchangers (`MX` record sets). */
  mxRecords?: MxRecord[];
  /** Name server domain names (`NS` record sets, for delegating a child zone). */
  nsRecords?: string[];
  /** Target domain names (`PTR` record sets). */
  ptrRecords?: string[];
  /** Service locations (`SRV` record sets). */
  srvRecords?: SrvRecord[];
  /**
   * Text values (`TXT` record sets), one string per record. Values longer
   * than 255 characters are split into 255-character strings.
   */
  txtRecords?: string[];
}

export interface RecordSetProps extends Records {
  /** Resource group of the zone. Changing it replaces the record set. */
  resourceGroup: string;
  /** Name of the DNS zone. Changing it replaces the record set. */
  zoneName: string;
  /**
   * DNS record type. Changing it replaces the record set; under the same
   * name, Alchemy deletes the old record set before it creates the new one.
   */
  recordType: RecordType;
  /**
   * Record set name relative to the zone, e.g. `www`, or `@` for the zone
   * apex. If omitted, a unique lowercase name is generated from the app,
   * stage, and logical ID. The apex `NS` record set is owned by Azure and
   * cannot be managed. Changing it replaces the record set.
   */
  name?: string;
  /**
   * Time-to-live of the records, in seconds.
   * @default 3600
   */
  ttl?: number;
  /**
   * ARM ID of an Azure resource the record set aliases (a public IP
   * address, Traffic Manager profile, Front Door, or CDN endpoint). Only
   * valid for `A`, `AAAA`, and `CNAME` record sets, and mutually exclusive
   * with literal records — Azure keeps the records in sync with the
   * resource. Changing it updates the record set in place.
   * @default no alias (literal records)
   */
  targetResourceId?: string;
  /**
   * User metadata (keys: letters, digits, and `_`). Alchemy ownership
   * markers (`alchemy_stack`, `alchemy_stage`, `alchemy_id`) are merged in
   * because record sets have no tags.
   * @default {}
   */
  metadata?: Record<string, string>;
}

export interface RecordSet extends Resource<
  "Azure.Dns.RecordSet",
  RecordSetProps,
  {
    /** Record set name relative to the zone. */
    recordSetName: string;
    /** ARM resource ID of the record set. */
    recordSetId: string;
    /** Name of the zone that holds the record set. */
    zoneName: string;
    /** Resource group of the zone. */
    resourceGroup: string;
    /** DNS record type. */
    recordType: RecordType;
    /** Fully qualified domain name of the record set (with a trailing dot). */
    fqdn: string | undefined;
    /** Time-to-live of the records, in seconds. */
    ttl: number;
    /** ARM ID of the aliased Azure resource, if this is an alias record set. */
    targetResourceId: string | undefined;
    /** IPv4 addresses (`A`). */
    aRecords: string[];
    /** IPv6 addresses (`AAAA`). */
    aaaaRecords: string[];
    /** Certification authority authorizations (`CAA`). */
    caaRecords: CaaRecord[];
    /** Canonical name (`CNAME`). */
    cname: string | undefined;
    /** Mail exchangers (`MX`). */
    mxRecords: MxRecord[];
    /** Name server domain names (`NS`). */
    nsRecords: string[];
    /** Target domain names (`PTR`). */
    ptrRecords: string[];
    /** Service locations (`SRV`). */
    srvRecords: SrvRecord[];
    /** Text values (`TXT`), one string per record. */
    txtRecords: string[];
    /** User metadata (Alchemy ownership markers stripped). */
    metadata: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A DNS record set in an Azure public DNS zone
 * (`Microsoft.Network/dnsZones/{type}`): all records of one type under one
 * name.
 *
 * A record set either holds literal records (set the field for its
 * `recordType`, e.g. `aRecords` for `A`) or aliases an Azure resource via
 * `targetResourceId`. Record sets cannot be tagged, so Alchemy records
 * ownership in the record set's metadata. Every change to the records,
 * `ttl`, or `metadata` is one in-place write.
 *
 * :::caution[Changing `name`, `recordType`, `zoneName`, or `resourceGroup` replaces the record set]
 * Alchemy creates the new record set and deletes the old one. When only
 * `recordType` changes, it deletes the old record set first, because a
 * `CNAME` cannot share a name with other records: the name does not
 * resolve until the new record set exists.
 * :::
 *
 * :::caution[The zone must exist first]
 * Create the zone with `Azure.Dns.Zone` (or name one that exists) and pass
 * `zone.zoneName`. Azure owns the zone's `SOA` record set and its apex `NS`
 * record set; you cannot manage them here.
 * :::
 *
 * @see https://learn.microsoft.com/azure/dns/dns-zones-records#record-sets
 *
 * ### Creating a Record Set
 * Set `name` relative to the zone (`www` for `www.contoso.com`, `@` for the
 * apex). If you omit it, Alchemy generates a unique name.
 *
 * **Example:** A record for `www`
 * ```typescript
 * const zone = yield* Azure.Dns.Zone("contoso", { name: "contoso.com" });
 * const www = yield* Azure.Dns.RecordSet("www", {
 *   zoneName: zone.zoneName,
 *   recordType: "A",
 *   name: "www",
 *   aRecords: ["203.0.113.10"],
 * });
 * // www.fqdn → "www.contoso.com."
 * ```
 *
 * **Example:** Short TTL and metadata
 * ```typescript
 * yield* Azure.Dns.RecordSet("canary", {
 *   zoneName: zone.zoneName,
 *   recordType: "A",
 *   name: "canary",
 *   ttl: 60,
 *   aRecords: ["203.0.113.20"],
 *   metadata: { owner: "platform_team" },
 * });
 * ```
 *
 * ### Address Records
 * **Example:** A record with two addresses
 * ```typescript
 * const www = yield* Azure.Dns.RecordSet("www", {
 *   zoneName: zone.zoneName,
 *   recordType: "A",
 *   name: "www",
 *   ttl: 300,
 *   aRecords: ["203.0.113.10", "203.0.113.11"],
 * });
 * ```
 *
 * **Example:** AAAA record
 * ```typescript
 * yield* Azure.Dns.RecordSet("www-v6", {
 *   zoneName: zone.zoneName,
 *   recordType: "AAAA",
 *   name: "www",
 *   aaaaRecords: ["2001:db8::10"],
 * });
 * ```
 *
 * ### Alias Records
 * An alias record set follows an Azure resource: Azure updates the records
 * when the resource's address changes. Set `targetResourceId` and leave the
 * literal record fields empty. Aliases work for `A`, `AAAA`, and `CNAME`.
 *
 * **Example:** Apex alias to a public IP address
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("ingress");
 * yield* Azure.Dns.RecordSet("apex", {
 *   zoneName: zone.zoneName,
 *   recordType: "A",
 *   name: "@",
 *   targetResourceId: ip.publicIpAddressId,
 * });
 * ```
 *
 * **Example:** Apex alias to a Front Door endpoint
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("cdn");
 * const endpoint = yield* Azure.Cdn.AfdEndpoint("web", {
 *   profile: profile.profileName,
 * });
 * yield* Azure.Dns.RecordSet("apex", {
 *   zoneName: zone.zoneName,
 *   recordType: "A",
 *   name: "@",
 *   targetResourceId: endpoint.endpointId,
 * });
 * ```
 *
 * ### Canonical Names
 * A `CNAME` record set holds exactly one `cname` and cannot share its name
 * with any other record set, so it cannot sit at the zone apex. Use an
 * alias `A` record set for the apex.
 *
 * **Example:** CNAME to a Web App
 * ```typescript
 * const api = yield* Azure.Web.WebApp("Api", { main: "./src/api.ts" });
 * yield* Azure.Dns.RecordSet("api", {
 *   zoneName: zone.zoneName,
 *   recordType: "CNAME",
 *   name: "api",
 *   cname: api.defaultHostName,
 * });
 * ```
 *
 * **Example:** CNAME to a fixed host name
 * ```typescript
 * yield* Azure.Dns.RecordSet("docs", {
 *   zoneName: zone.zoneName,
 *   recordType: "CNAME",
 *   name: "docs",
 *   cname: "contoso.azurewebsites.net",
 * });
 * ```
 *
 * ### Text Records
 * Each entry in `txtRecords` is one TXT record. Alchemy splits a value
 * longer than 255 characters into 255-character strings, as DNS requires.
 *
 * **Example:** SPF and site verification at the apex
 * ```typescript
 * yield* Azure.Dns.RecordSet("verify", {
 *   zoneName: zone.zoneName,
 *   recordType: "TXT",
 *   name: "@",
 *   txtRecords: [
 *     "v=spf1 include:spf.protection.outlook.com -all",
 *     "google-site-verification=abc123",
 *   ],
 * });
 * ```
 *
 * **Example:** DKIM public key
 * ```typescript
 * yield* Azure.Dns.RecordSet("dkim", {
 *   zoneName: zone.zoneName,
 *   recordType: "TXT",
 *   name: "selector1._domainkey",
 *   txtRecords: ["v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA..."],
 * });
 * ```
 *
 * ### Mail Records
 * **Example:** MX records with a backup mail host
 * ```typescript
 * yield* Azure.Dns.RecordSet("mail", {
 *   zoneName: zone.zoneName,
 *   recordType: "MX",
 *   name: "@",
 *   mxRecords: [
 *     { preference: 10, exchange: "contoso-com.mail.protection.outlook.com" },
 *     { preference: 20, exchange: "backup-mx.contoso.com" },
 *   ],
 * });
 * ```
 *
 * ### Certificate Authority Authorization
 * `CAA` records list the certificate authorities that may issue
 * certificates for the domain. Set `flags: 128` to mark a record critical.
 *
 * **Example:** Allow one issuer and report violations
 * ```typescript
 * yield* Azure.Dns.RecordSet("caa", {
 *   zoneName: zone.zoneName,
 *   recordType: "CAA",
 *   name: "@",
 *   caaRecords: [
 *     { flags: 0, tag: "issue", value: "letsencrypt.org" },
 *     { flags: 0, tag: "iodef", value: "mailto:security@contoso.com" },
 *   ],
 * });
 * ```
 *
 * ### Service Records
 * **Example:** SRV record for SIP over TLS
 * ```typescript
 * yield* Azure.Dns.RecordSet("sip", {
 *   zoneName: zone.zoneName,
 *   recordType: "SRV",
 *   name: "_sips._tcp",
 *   srvRecords: [{ priority: 10, weight: 60, port: 5061, target: "sip.contoso.com" }],
 * });
 * ```
 *
 * ### Reverse DNS
 * Put `PTR` records in a reverse-lookup zone such as
 * `113.0.203.in-addr.arpa`.
 *
 * **Example:** PTR record for 203.0.113.10
 * ```typescript
 * const reverse = yield* Azure.Dns.Zone("reverse", {
 *   name: "113.0.203.in-addr.arpa",
 * });
 * yield* Azure.Dns.RecordSet("ptr-10", {
 *   zoneName: reverse.zoneName,
 *   recordType: "PTR",
 *   name: "10",
 *   ptrRecords: ["mail.contoso.com"],
 * });
 * ```
 *
 * ### Delegating a Subdomain
 * **Example:** NS record for a child zone
 * ```typescript
 * const childZone = yield* Azure.Dns.Zone("dev", { name: "dev.contoso.com" });
 * yield* Azure.Dns.RecordSet("dev", {
 *   zoneName: zone.zoneName,
 *   recordType: "NS",
 *   name: "dev",
 *   nsRecords: childZone.nameServers,
 * });
 * ```
 *
 * ### Custom Domain Validation
 * App Service and Front Door prove you own a domain through TXT records.
 * Create the record sets in the same stack as the domain.
 *
 * **Example:** Web App custom domain (`asuid` TXT plus CNAME)
 * ```typescript
 * const api = yield* Azure.Web.WebApp("Api", { main: "./src/api.ts" });
 * yield* Azure.Dns.RecordSet("www-verify", {
 *   zoneName: zone.zoneName,
 *   recordType: "TXT",
 *   name: "asuid.www",
 *   txtRecords: [api.customDomainVerificationId.as<string>()],
 * });
 * yield* Azure.Dns.RecordSet("www", {
 *   zoneName: zone.zoneName,
 *   recordType: "CNAME",
 *   name: "www",
 *   cname: api.defaultHostName,
 * });
 * ```
 *
 * **Example:** Front Door custom domain (`_dnsauth` TXT plus CNAME)
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("cdn");
 * const endpoint = yield* Azure.Cdn.AfdEndpoint("web", {
 *   profile: profile.profileName,
 * });
 * const domain = yield* Azure.Cdn.AfdCustomDomain("www", {
 *   profile: profile.profileName,
 *   hostName: "www.contoso.com",
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
 * @resource
 */
export const RecordSet = GroupedResource<RecordSet>("Azure.Dns.RecordSet");

const DEFAULT_TTL = 3600;

const createRecordSetName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 63,
    lowercase: true,
  });
  return name.replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
});

const getRecordSet = (
  subscriptionId: string,
  resourceGroupName: string,
  zoneName: string,
  recordType: RecordType,
  relativeRecordSetName: string,
) =>
  orUndefinedIfNotFound(
    dns.GetRecordSet({
      subscriptionId,
      resourceGroupName,
      zoneName,
      recordType,
      relativeRecordSetName,
    }),
  );

const chunkTxt = (value: string) => {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += 255) {
    chunks.push(value.slice(i, i + 255));
  }
  return chunks.length === 0 ? [""] : chunks;
};

const host = (name: string | undefined) => (name ?? "").replace(/\.$/, "").toLowerCase();

/** Desired/observed state of a record set in canonical (sorted) form. */
const canonical = (
  recordType: RecordType,
  records: Records,
  targetResourceId: string | undefined,
) => {
  const sortBy = <T>(items: T[], key: (item: T) => string) =>
    [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  if (targetResourceId !== undefined) {
    return { targetResourceId: targetResourceId.toLowerCase() };
  }
  switch (recordType) {
    case "A":
      return { a: sortBy(records.aRecords ?? [], (x) => x) };
    case "AAAA":
      return {
        aaaa: sortBy(
          (records.aaaaRecords ?? []).map((x) => x.toLowerCase()),
          (x) => x,
        ),
      };
    case "CAA":
      return {
        caa: sortBy(
          (records.caaRecords ?? []).map((r) => ({
            flags: r.flags,
            tag: r.tag,
            value: r.value,
          })),
          (r) => `${r.flags}/${r.tag}/${r.value}`,
        ),
      };
    case "CNAME":
      return { cname: records.cname === undefined ? "" : host(records.cname) };
    case "MX":
      return {
        mx: sortBy(
          (records.mxRecords ?? []).map((mx) => ({
            preference: mx.preference,
            exchange: host(mx.exchange),
          })),
          (mx) => `${mx.preference}/${mx.exchange}`,
        ),
      };
    case "NS":
      return { ns: sortBy((records.nsRecords ?? []).map(host), (x) => x) };
    case "PTR":
      return { ptr: sortBy((records.ptrRecords ?? []).map(host), (x) => x) };
    case "SRV":
      return {
        srv: sortBy(
          (records.srvRecords ?? []).map((srv) => ({
            priority: srv.priority,
            weight: srv.weight,
            port: srv.port,
            target: host(srv.target),
          })),
          (s) => `${s.priority}/${s.weight}/${s.port}/${s.target}`,
        ),
      };
    case "TXT":
      return { txt: sortBy(records.txtRecords ?? [], (x) => x) };
  }
};

/** Records as observed on a record set. */
const observedRecords = (
  properties: dns.RecordSetProperties | undefined,
): Required<Omit<Records, "cname">> & { cname: string | undefined } => ({
  aRecords: (properties?.ARecords ?? []).flatMap((r) =>
    r.ipv4Address === undefined ? [] : [r.ipv4Address],
  ),
  aaaaRecords: (properties?.AAAARecords ?? []).flatMap((r) =>
    r.ipv6Address === undefined ? [] : [r.ipv6Address],
  ),
  caaRecords: (properties?.caaRecords ?? []).map((r) => ({
    flags: r.flags ?? 0,
    tag: r.tag ?? "",
    value: r.value ?? "",
  })),
  cname: properties?.CNAMERecord?.cname,
  mxRecords: (properties?.MXRecords ?? []).map((r) => ({
    preference: r.preference ?? 0,
    exchange: r.exchange ?? "",
  })),
  nsRecords: (properties?.NSRecords ?? []).flatMap((r) =>
    r.nsdname === undefined ? [] : [r.nsdname],
  ),
  ptrRecords: (properties?.PTRRecords ?? []).flatMap((r) =>
    r.ptrdname === undefined ? [] : [r.ptrdname],
  ),
  srvRecords: (properties?.SRVRecords ?? []).map((r) => ({
    priority: r.priority ?? 0,
    weight: r.weight ?? 0,
    port: r.port ?? 0,
    target: r.target ?? "",
  })),
  txtRecords: (properties?.TXTRecords ?? []).map((r) => (r.value ?? []).join("")),
});

/** Request body for the records of the given type. */
const recordsBody = (
  recordType: RecordType,
  records: Records,
): Partial<dns.RecordSetPropertiesInput> => {
  switch (recordType) {
    case "A":
      return {
        ARecords: (records.aRecords ?? []).map((ipv4Address) => ({
          ipv4Address,
        })),
      };
    case "AAAA":
      return {
        AAAARecords: (records.aaaaRecords ?? []).map((ipv6Address) => ({
          ipv6Address,
        })),
      };
    case "CAA":
      return { caaRecords: records.caaRecords ?? [] };
    case "CNAME":
      return { CNAMERecord: { cname: records.cname } };
    case "MX":
      return { MXRecords: records.mxRecords ?? [] };
    case "NS":
      return {
        NSRecords: (records.nsRecords ?? []).map((nsdname) => ({ nsdname })),
      };
    case "PTR":
      return {
        PTRRecords: (records.ptrRecords ?? []).map((ptrdname) => ({
          ptrdname,
        })),
      };
    case "SRV":
      return { SRVRecords: records.srvRecords ?? [] };
    case "TXT":
      return {
        TXTRecords: (records.txtRecords ?? []).map((value) => ({
          value: chunkTxt(value),
        })),
      };
  }
};

/** Record type from an ARM type such as `Microsoft.Network/dnszones/A`. */
const recordTypeOf = (armType: string | undefined): RecordType | undefined => {
  const type = armType?.split("/").pop()?.toUpperCase();
  return type === "A" ||
    type === "AAAA" ||
    type === "CAA" ||
    type === "CNAME" ||
    type === "MX" ||
    type === "NS" ||
    type === "PTR" ||
    type === "SRV" ||
    type === "TXT"
    ? type
    : undefined;
};

const toAttrs = (
  resourceGroup: string,
  zoneName: string,
  recordType: RecordType,
  name: string,
  recordSet: dns.RecordSet,
): RecordSet["Attributes"] => ({
  recordSetName: name,
  recordSetId: recordSet.id ?? "",
  zoneName,
  resourceGroup,
  recordType,
  fqdn: recordSet.properties?.fqdn,
  ttl: recordSet.properties?.TTL ?? DEFAULT_TTL,
  targetResourceId: recordSet.properties?.targetResource?.id,
  ...observedRecords(recordSet.properties),
  metadata: userMetadata(recordSet.properties?.metadata),
});

export const RecordSetProvider = () =>
  Provider.succeed(RecordSet, {
    stables: ["recordSetName", "recordSetId", "zoneName", "resourceGroup", "recordType", "fqdn"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const zones = yield* collectAll(dns.ListZones, { subscriptionId });
      const found: RecordSet["Attributes"][] = [];
      for (const zone of zones.value ?? []) {
        const group = resourceGroupOf(zone.id);
        if (group === undefined || zone.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          collectAll(dns.ListRecordSetByDnsZone, {
            subscriptionId,
            resourceGroupName: group,
            zoneName: zone.name,
          }),
        );
        for (const recordSet of page?.value ?? []) {
          const recordType = recordTypeOf(recordSet.type);
          if (
            recordType !== undefined &&
            recordSet.name !== undefined &&
            hasAnyMarker(recordSet.properties?.metadata)
          ) {
            found.push(toAttrs(group, zone.name, recordType, recordSet.name, recordSet));
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sameZone =
        sameArm(news.resourceGroup, output.resourceGroup) &&
        sameArm(news.zoneName, output.zoneName);
      const sameName = news.name === undefined || sameArm(news.name, output.recordSetName);
      if (!sameZone || !sameName || news.recordType !== output.recordType) {
        // A CNAME cannot coexist with other records under the same name.
        return {
          action: "replace",
          deleteFirst: sameZone && sameName,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const zoneName = output?.zoneName ?? olds?.zoneName;
      const recordType = output?.recordType ?? olds?.recordType;
      if (resourceGroup === undefined || zoneName === undefined || recordType === undefined) {
        return undefined;
      }
      const name = output?.recordSetName ?? olds?.name ?? (yield* createRecordSetName(id));
      const observed = yield* getRecordSet(
        subscriptionId,
        resourceGroup,
        zoneName,
        recordType,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, zoneName, recordType, name, observed);
      return (yield* ownsMetadata(id, observed.properties?.metadata)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const { resourceGroup, zoneName, recordType, targetResourceId } = news;
      const name = news.name ?? output?.recordSetName ?? (yield* createRecordSetName(id));
      const ttl = news.ttl ?? DEFAULT_TTL;
      const metadata = yield* desiredMetadata(id, news.metadata);
      const desired = JSON.stringify(canonical(recordType, news, targetResourceId));
      const get = getRecordSet(subscriptionId, resourceGroup, zoneName, recordType, name);
      const converged = (recordSet: dns.RecordSet | undefined) =>
        recordSet !== undefined &&
        (recordSet.properties?.TTL ?? DEFAULT_TTL) === ttl &&
        sameMap(recordSet.properties?.metadata, metadata) &&
        JSON.stringify(
          canonical(
            recordType,
            observedRecords(recordSet.properties),
            recordSet.properties?.targetResource?.id,
          ),
        ) === desired;

      // Observe.
      const observed = yield* get;

      // Ensure + sync: record-set PUT is a synchronous full upsert, so one
      // write converges a missing or drifted record set.
      if (!converged(observed)) {
        yield* dns.RecordSetsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          zoneName,
          recordType,
          relativeRecordSetName: name,
          properties: {
            TTL: ttl,
            metadata,
            ...(targetResourceId !== undefined
              ? { targetResource: { id: targetResourceId } }
              : recordsBody(recordType, news)),
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `DNS record set ${recordType} ${name}`,
        get,
        (recordSet) => (converged(recordSet) ? "Succeeded" : "Updating"),
        DNS_BUDGET,
      );
      return toAttrs(resourceGroup, zoneName, recordType, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        dns.DeleteRecordSet({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          zoneName: output.zoneName,
          recordType: output.recordType,
          relativeRecordSetName: output.recordSetName,
        }),
      );
      yield* waitUntilGone(
        `DNS record set ${output.recordType} ${output.recordSetName}`,
        getRecordSet(
          subscriptionId,
          output.resourceGroup,
          output.zoneName,
          output.recordType,
          output.recordSetName,
        ),
        DNS_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.Dns.Zone", "Azure.Resources.ResourceGroup"],
    },
  });
