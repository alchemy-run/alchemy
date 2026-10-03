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
  hasAnyMarker,
  ownsMetadata,
  PRIVATE_DNS_BUDGET,
  sameArm,
  sameMap,
  userMetadata,
} from "./Common.ts";

/**
 * Record types a record set can hold. The zone's `SOA` record set is
 * created and deleted with the zone and is not managed here.
 */
export type RecordType = "A" | "AAAA" | "CNAME" | "MX" | "PTR" | "SRV" | "TXT";

export interface MxRecord {
  /** Preference of this mail exchanger; lower values are preferred. */
  preference: number;
  /** Domain name of the mail host. */
  exchange: string;
}

export interface SrvRecord {
  /** Priority of the target host; lower values are preferred. */
  priority: number;
  /** Relative weight among targets with the same priority. */
  weight: number;
  /** Port the service listens on. */
  port: number;
  /** Domain name of the target host. */
  target: string;
}

/** The records of a record set, by type. Only the field for `recordType` is used. */
export interface Records {
  /** IPv4 addresses (`A` record sets). */
  aRecords?: string[];
  /** IPv6 addresses (`AAAA` record sets). */
  aaaaRecords?: string[];
  /** Canonical name (`CNAME` record sets hold exactly one). */
  cname?: string;
  /** Mail exchangers (`MX` record sets). */
  mxRecords?: MxRecord[];
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
  /** Name of the private DNS zone. Changing it replaces the record set. */
  privateZoneName: string;
  /** DNS record type. Changing it replaces the record set. */
  recordType: RecordType;
  /**
   * Record set name relative to the zone, e.g. `www`, or `@` for the zone
   * apex. If omitted, a unique lowercase name is generated from the app,
   * stage, and logical ID. Changing it replaces the record set.
   */
  name?: string;
  /**
   * Time-to-live of the records, in seconds.
   * @default 3600
   */
  ttl?: number;
  /**
   * User metadata (keys: letters, digits, and `_`). Alchemy ownership
   * markers (`alchemy_stack`, `alchemy_stage`, `alchemy_id`) are merged in
   * because record sets have no tags.
   */
  metadata?: Record<string, string>;
}

export interface RecordSet extends Resource<
  "Azure.PrivateDns.RecordSet",
  RecordSetProps,
  {
    /** Record set name relative to the zone. */
    recordSetName: string;
    /** ARM resource ID of the record set. */
    recordSetId: string;
    /** Name of the zone that holds the record set. */
    privateZoneName: string;
    /** Resource group of the zone. */
    resourceGroup: string;
    /** DNS record type. */
    recordType: RecordType;
    /** Fully qualified domain name of the record set. */
    fqdn: string | undefined;
    /** Time-to-live of the records, in seconds. */
    ttl: number;
    /** IPv4 addresses (`A`). */
    aRecords: string[];
    /** IPv6 addresses (`AAAA`). */
    aaaaRecords: string[];
    /** Canonical name (`CNAME`). */
    cname: string | undefined;
    /** Mail exchangers (`MX`). */
    mxRecords: MxRecord[];
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
 * A DNS record set in an Azure Private DNS zone: all records of one type
 * under one name.
 *
 * Record sets cannot be tagged, so Alchemy records ownership in the record
 * set's metadata. Records auto-registered by virtual machines are never
 * adopted.
 *
 * @see https://learn.microsoft.com/azure/dns/private-dns-privatednszone#record-sets
 *
 * ### Address Records
 * **Example:** A record with two addresses
 * ```typescript
 * const www = yield* Azure.PrivateDns.RecordSet("www", {
 *   resourceGroup: group.resourceGroupName,
 *   privateZoneName: zone.privateZoneName,
 *   recordType: "A",
 *   name: "www",
 *   ttl: 300,
 *   aRecords: ["10.0.0.4", "10.0.0.5"],
 * });
 * ```
 *
 * ### Aliases and Text
 * **Example:** CNAME record
 * ```typescript
 * yield* Azure.PrivateDns.RecordSet("api", {
 *   resourceGroup: group.resourceGroupName,
 *   privateZoneName: zone.privateZoneName,
 *   recordType: "CNAME",
 *   name: "api",
 *   cname: "www.internal.contoso.com",
 * });
 * ```
 *
 * **Example:** TXT record
 * ```typescript
 * yield* Azure.PrivateDns.RecordSet("verify", {
 *   resourceGroup: group.resourceGroupName,
 *   privateZoneName: zone.privateZoneName,
 *   recordType: "TXT",
 *   name: "_verify",
 *   txtRecords: ["v=verification-token"],
 * });
 * ```
 *
 * ### Service Records
 * **Example:** SRV record
 * ```typescript
 * yield* Azure.PrivateDns.RecordSet("ldap", {
 *   resourceGroup: group.resourceGroupName,
 *   privateZoneName: zone.privateZoneName,
 *   recordType: "SRV",
 *   name: "_ldap._tcp",
 *   srvRecords: [{ priority: 10, weight: 5, port: 389, target: "dc1.internal.contoso.com" }],
 * });
 * ```
 *
 * @resource
 */
export const RecordSet = Resource<RecordSet>("Azure.PrivateDns.RecordSet");

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
  privateZoneName: string,
  recordType: RecordType,
  relativeRecordSetName: string,
) =>
  orUndefinedIfNotFound(
    privatedns.GetRecordSet({
      subscriptionId,
      resourceGroupName,
      privateZoneName,
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

const host = (name: string | undefined) => (name ?? "").replace(/\.$/, "");

/** Records of the given type in canonical (sorted) form. */
const canonical = (recordType: RecordType, records: Records) => {
  const sortBy = <T>(items: T[], key: (item: T) => string) =>
    [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return {
    aRecords:
      recordType === "A" ? sortBy(records.aRecords ?? [], (x) => x) : [],
    aaaaRecords:
      recordType === "AAAA"
        ? sortBy(
            (records.aaaaRecords ?? []).map((x) => x.toLowerCase()),
            (x) => x,
          )
        : [],
    cname:
      recordType === "CNAME" && records.cname !== undefined
        ? host(records.cname)
        : undefined,
    mxRecords:
      recordType === "MX"
        ? sortBy(
            (records.mxRecords ?? []).map((mx) => ({
              preference: mx.preference,
              exchange: host(mx.exchange),
            })),
            (mx) => `${mx.preference}/${mx.exchange}`,
          )
        : [],
    ptrRecords:
      recordType === "PTR"
        ? sortBy((records.ptrRecords ?? []).map(host), (x) => x)
        : [],
    srvRecords:
      recordType === "SRV"
        ? sortBy(
            (records.srvRecords ?? []).map((srv) => ({
              priority: srv.priority,
              weight: srv.weight,
              port: srv.port,
              target: host(srv.target),
            })),
            (s) => `${s.priority}/${s.weight}/${s.port}/${s.target}`,
          )
        : [],
    txtRecords:
      recordType === "TXT" ? sortBy(records.txtRecords ?? [], (x) => x) : [],
  };
};

/** Records as observed on a record set. */
const observedRecords = (
  properties: privatedns.RecordSetProperties | undefined,
): Records => ({
  aRecords: (properties?.aRecords ?? []).flatMap((r) =>
    r.ipv4Address === undefined ? [] : [r.ipv4Address],
  ),
  aaaaRecords: (properties?.aaaaRecords ?? []).flatMap((r) =>
    r.ipv6Address === undefined ? [] : [r.ipv6Address],
  ),
  cname: properties?.cnameRecord?.cname,
  mxRecords: (properties?.mxRecords ?? []).map((r) => ({
    preference: r.preference ?? 0,
    exchange: r.exchange ?? "",
  })),
  ptrRecords: (properties?.ptrRecords ?? []).flatMap((r) =>
    r.ptrdname === undefined ? [] : [r.ptrdname],
  ),
  srvRecords: (properties?.srvRecords ?? []).map((r) => ({
    priority: r.priority ?? 0,
    weight: r.weight ?? 0,
    port: r.port ?? 0,
    target: r.target ?? "",
  })),
  txtRecords: (properties?.txtRecords ?? []).map((r) =>
    (r.value ?? []).join(""),
  ),
});

/** Request body for the records of the given type. */
const recordsBody = (recordType: RecordType, records: Records) => {
  switch (recordType) {
    case "A":
      return {
        aRecords: (records.aRecords ?? []).map((ipv4Address) => ({
          ipv4Address,
        })),
      };
    case "AAAA":
      return {
        aaaaRecords: (records.aaaaRecords ?? []).map((ipv6Address) => ({
          ipv6Address,
        })),
      };
    case "CNAME":
      return { cnameRecord: { cname: records.cname } };
    case "MX":
      return { mxRecords: records.mxRecords ?? [] };
    case "PTR":
      return {
        ptrRecords: (records.ptrRecords ?? []).map((ptrdname) => ({
          ptrdname,
        })),
      };
    case "SRV":
      return { srvRecords: records.srvRecords ?? [] };
    case "TXT":
      return {
        txtRecords: (records.txtRecords ?? []).map((value) => ({
          value: chunkTxt(value),
        })),
      };
  }
};

/** Record type from an ARM type such as `Microsoft.Network/privateDnsZones/A`. */
const recordTypeOf = (armType: string | undefined): RecordType | undefined => {
  const type = armType?.split("/").pop()?.toUpperCase();
  return type === "A" ||
    type === "AAAA" ||
    type === "CNAME" ||
    type === "MX" ||
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
  recordSet: privatedns.GetRecordSetResponse | privatedns.RecordSet,
): RecordSet["Attributes"] => {
  const records = observedRecords(recordSet.properties);
  return {
    recordSetName: name,
    recordSetId: recordSet.id ?? "",
    privateZoneName: zoneName,
    resourceGroup,
    recordType,
    fqdn: recordSet.properties?.fqdn,
    ttl: recordSet.properties?.ttl ?? DEFAULT_TTL,
    aRecords: records.aRecords ?? [],
    aaaaRecords: records.aaaaRecords ?? [],
    cname: records.cname,
    mxRecords: records.mxRecords ?? [],
    ptrRecords: records.ptrRecords ?? [],
    srvRecords: records.srvRecords ?? [],
    txtRecords: records.txtRecords ?? [],
    metadata: userMetadata(recordSet.properties?.metadata),
  };
};

export const RecordSetProvider = () =>
  Provider.succeed(RecordSet, {
    stables: [
      "recordSetName",
      "recordSetId",
      "privateZoneName",
      "resourceGroup",
      "recordType",
      "fqdn",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const zones = yield* privatedns
        .ListPrivateZones({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListPrivateZones", page)),
        );
      const found: RecordSet["Attributes"][] = [];
      for (const zone of zones.value ?? []) {
        const group = resourceGroupOf(zone.id);
        if (group === undefined || zone.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          privatedns.ListRecordSets({
            subscriptionId,
            resourceGroupName: group,
            privateZoneName: zone.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage("ListRecordSets", page);
        }
        for (const recordSet of page?.value ?? []) {
          const recordType = recordTypeOf(recordSet.type);
          if (
            recordType !== undefined &&
            recordSet.name !== undefined &&
            recordSet.properties?.isAutoRegistered !== true &&
            hasAnyMarker(recordSet.properties?.metadata)
          ) {
            found.push(
              toAttrs(group, zone.name, recordType, recordSet.name, recordSet),
            );
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sameZone =
        sameArm(news.resourceGroup, output.resourceGroup) &&
        sameArm(news.privateZoneName, output.privateZoneName);
      const sameName =
        news.name === undefined || sameArm(news.name, output.recordSetName);
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
      const zoneName = output?.privateZoneName ?? olds?.privateZoneName;
      const recordType = output?.recordType ?? olds?.recordType;
      if (
        resourceGroup === undefined ||
        zoneName === undefined ||
        recordType === undefined
      ) {
        return undefined;
      }
      const name =
        output?.recordSetName ?? olds?.name ?? (yield* createRecordSetName(id));
      const observed = yield* getRecordSet(
        subscriptionId,
        resourceGroup,
        zoneName,
        recordType,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        zoneName,
        recordType,
        name,
        observed,
      );
      return observed.properties?.isAutoRegistered !== true &&
        (yield* ownsMetadata(id, observed.properties?.metadata))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const { resourceGroup, privateZoneName: zoneName, recordType } = news;
      const name =
        news.name ?? output?.recordSetName ?? (yield* createRecordSetName(id));
      const ttl = news.ttl ?? DEFAULT_TTL;
      const metadata = yield* desiredMetadata(id, news.metadata);
      const desired = JSON.stringify(canonical(recordType, news));
      const get = getRecordSet(
        subscriptionId,
        resourceGroup,
        zoneName,
        recordType,
        name,
      );
      const converged = (
        recordSet: privatedns.GetRecordSetResponse | undefined,
      ) =>
        recordSet !== undefined &&
        (recordSet.properties?.ttl ?? DEFAULT_TTL) === ttl &&
        sameMap(recordSet.properties?.metadata, metadata) &&
        JSON.stringify(
          canonical(recordType, observedRecords(recordSet.properties)),
        ) === desired;

      // Observe.
      const observed = yield* get;

      // Ensure + sync: record-set PUT is a synchronous full upsert, so one
      // write converges a missing or drifted record set.
      if (!converged(observed)) {
        yield* privatedns.RecordSetsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          privateZoneName: zoneName,
          recordType,
          relativeRecordSetName: name,
          properties: {
            ttl,
            metadata,
            ...recordsBody(recordType, news),
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `private DNS record set ${recordType} ${name}`,
        get,
        (recordSet) => (converged(recordSet) ? "Succeeded" : "Updating"),
        PRIVATE_DNS_BUDGET,
      );
      return toAttrs(resourceGroup, zoneName, recordType, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        privatedns.DeleteRecordSet({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateZoneName: output.privateZoneName,
          recordType: output.recordType,
          relativeRecordSetName: output.recordSetName,
        }),
      );
      yield* waitUntilGone(
        `private DNS record set ${output.recordType} ${output.recordSetName}`,
        getRecordSet(
          subscriptionId,
          output.resourceGroup,
          output.privateZoneName,
          output.recordType,
          output.recordSetName,
        ),
        PRIVATE_DNS_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.PrivateDns.Zone", "Azure.Resources.ResourceGroup"],
    },
  });
