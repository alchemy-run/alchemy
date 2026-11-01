import * as dns from "@distilled.cloud/stackit/dns";
import { Unowned } from "alchemy/AdoptPolicy";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { recordsEqual } from "alchemy/Util/equal";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { ensureServiceEnabled } from "../internal/enable.ts";
import { sameMembers } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import {
  desiredLabels,
  hasAlchemyLabels,
  isAlchemyOwned,
  labelRecord,
  stripInternalLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DNS_SERVICE_ID,
  DNS_TIMEOUT,
  getZoneOrUndefined,
  isSucceeded,
  normalizeDnsName,
} from "./internal.ts";

/** STACKIT DNS zone type. */
export type ZoneType = "primary" | "secondary";

export interface ZoneProps {
  /**
   * DNS name of the zone, e.g. `example.com` or `app.example.com`. A
   * trailing dot is ignored. STACKIT accepts any syntactically valid name;
   * the zone only answers public queries once the parent domain delegates
   * to the zone's name servers (`primaryNameServer`). Changing it replaces
   * the zone.
   *
   * If omitted, a unique name under `runs.onstackit.cloud` is generated from
   * the stack, stage and logical ID.
   */
  dnsName?: string;
  /**
   * Display name of the zone in the STACKIT portal. Updates in place.
   *
   * @default the zone's `dnsName`
   */
  name?: string;
  /**
   * Description of the zone. Updates in place; omit to leave the live value
   * alone.
   */
  description?: string;
  /**
   * Contact e-mail published in the zone's SOA record. Updates in place;
   * omit to keep STACKIT's default.
   */
  contactEmail?: string;
  /**
   * Default TTL in seconds for record sets that don't set their own.
   * Updates in place; omit to keep STACKIT's default (`3600`) on create and
   * leave the live value alone on update.
   */
  defaultTTL?: number;
  /**
   * SOA refresh time in seconds. Updates in place; omit to keep the live
   * value.
   */
  refreshTime?: number;
  /**
   * SOA retry time in seconds. Updates in place; omit to keep the live
   * value.
   */
  retryTime?: number;
  /**
   * SOA expire time in seconds. Updates in place; omit to keep the live
   * value.
   */
  expireTime?: number;
  /**
   * Negative caching TTL (SOA minimum) in seconds. Updates in place; omit to
   * keep the live value.
   */
  negativeCache?: number;
  /**
   * Zone type. `primary` zones are edited through `Stackit.DNS.RecordSet`;
   * `secondary` zones are transferred from the `primaries` name servers.
   * Changing it replaces the zone.
   *
   * @default "primary"
   */
  type?: ZoneType;
  /**
   * Primary name servers (IP addresses) a `secondary` zone transfers from.
   * Updates in place.
   */
  primaries?: string[];
  /**
   * Whether the zone is a reverse-lookup zone (`in-addr.arpa` /
   * `ip6.arpa`). Changing it replaces the zone.
   *
   * @default false
   */
  isReverseZone?: boolean;
  /**
   * Access control list of the zone. STACKIT documents that this field
   * currently has no effect. Updates in place; omit to keep the live value.
   */
  acl?: string;
  /**
   * Id of the STACKIT Observability instance the zone exports its query logs
   * to. Updates in place. When omitted, the live setting is left alone, so
   * removing this prop does not stop an export already running.
   */
  observabilityInstanceId?: string;
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`) are always merged in. Updates in place.
   */
  labels?: Record<string, string>;
  /**
   * Project that owns the zone. Defaults to the profile's project. Changing
   * it replaces the zone.
   */
  projectId?: string;
}

export interface ZoneAttributes {
  /** STACKIT zone id (UUID). Stable across updates. */
  zoneId: string;
  /** Project that owns the zone. */
  projectId: string;
  /** DNS name of the zone, without a trailing dot. */
  dnsName: string;
  /** Display name of the zone. */
  name: string;
  /** Description of the zone, if any. */
  description: string | undefined;
  /** SOA contact e-mail, if any. */
  contactEmail: string | undefined;
  /** Default TTL in seconds. */
  defaultTTL: number;
  /** SOA refresh time in seconds. */
  refreshTime: number;
  /** SOA retry time in seconds. */
  retryTime: number;
  /** SOA expire time in seconds. */
  expireTime: number;
  /** Negative caching TTL in seconds. */
  negativeCache: number;
  /** Zone type. */
  type: ZoneType;
  /** Primary name servers of a secondary zone. */
  primaries: string[];
  /** Whether the zone is a reverse-lookup zone. */
  isReverseZone: boolean;
  /** Access control list. */
  acl: string;
  /** Observability instance the zone exports its query logs to, if any. */
  observabilityInstanceId: string | undefined;
  /** State of the log export: `CREATING`, `CREATE_SUCCEEDED` or `ERROR`. */
  observabilityState: string | undefined;
  /** Primary (SOA) name server of the zone, an FQDN. Delegate the parent domain here. */
  primaryNameServer: string;
  /** SOA serial number. */
  serialNumber: number;
  /** Zone state; `CREATE_SUCCEEDED` or `UPDATE_SUCCEEDED` after a deploy. */
  state: string;
  /** Visibility of the zone (`public`). */
  visibility: string;
  /** Whether the zone is active. */
  active: boolean;
  /** Number of records in the zone. */
  recordCount: number;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
}

export type Zone = Resource<"Stackit.DNS.Zone", ZoneProps, ZoneAttributes, never, Providers>;

/**
 * A STACKIT DNS zone: an authoritative zone hosted on STACKIT's name
 * servers. Record sets are a separate resource, `Stackit.DNS.RecordSet`.
 *
 * The `dnsName` is the zone's identity: changing it, the `type`, the
 * `isReverseZone` flag or the `projectId` replaces the zone. Everything
 * else (display name, description, SOA timers, labels, primaries) updates
 * in place. Creates, updates and deletes are asynchronous on STACKIT;
 * deploys wait until the zone reports `CREATE_SUCCEEDED` /
 * `UPDATE_SUCCEEDED`, and destroys wait until it is gone. The first deploy
 * also enables the DNS service (`cloud.stackit.dns`) for the project.
 *
 * Ownership is tracked with STACKIT zone labels (`alchemy.stack`,
 * `alchemy.stage`, `alchemy.id`). A zone with the same `dnsName` that lacks
 * them is reported as unowned and only taken over with `--adopt`.
 *
 * ### Creating a Zone
 * **Example:** Primary zone for a domain you own
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const zone = yield* Stackit.DNS.Zone("Zone", {
 *   dnsName: "example.com",
 *   contactEmail: "hostmaster@example.com",
 *   defaultTTL: 3600,
 * });
 * // Delegate example.com at your registrar to zone.primaryNameServer.
 * ```
 *
 * **Example:** Zone with a generated name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // dnsName becomes "<app>-zone-<stage>-<suffix>.runs.onstackit.cloud"
 * const zone = yield* Stackit.DNS.Zone("Zone", {});
 * ```
 *
 * ### Configuring the Zone
 * **Example:** SOA timers, description and labels
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const zone = yield* Stackit.DNS.Zone("Zone", {
 *   dnsName: "example.com",
 *   name: "Example production zone",
 *   description: "Managed by Alchemy",
 *   refreshTime: 3600,
 *   retryTime: 600,
 *   expireTime: 1209600,
 *   negativeCache: 60,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** Secondary zone transferred from your own primary
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const zone = yield* Stackit.DNS.Zone("Secondary", {
 *   dnsName: "example.org",
 *   type: "secondary",
 *   primaries: ["192.0.2.53"],
 * });
 * ```
 *
 * ### Adding Records
 * **Example:** A zone with a `www` record set
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const zone = yield* Stackit.DNS.Zone("Zone", { dnsName: "example.com" });
 * yield* Stackit.DNS.RecordSet("Www", {
 *   zoneId: zone.zoneId,
 *   name: "www",
 *   type: "A",
 *   records: ["192.0.2.10"],
 * });
 * ```
 *
 * ### Exporting query logs
 * **Example:** Send the zone's query logs to an Observability instance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const zone = yield* Stackit.DNS.Zone("Zone", {
 *   dnsName: "example.com",
 *   observabilityInstanceId: "00000000-0000-0000-0000-000000000000",
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Changing the dnsName creates a new zone
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // Moving from example.com to example.net creates the new zone first,
 * // repoints dependent record sets, then deletes the old zone and every
 * // record in it. Re-delegate the domain to the new name servers.
 * const zone = yield* Stackit.DNS.Zone("Zone", { dnsName: "example.net" });
 * ```
 *
 * @resource
 * @product STACKIT DNS
 * @category DNS
 */
export const Zone = Resource<Zone>("Stackit.DNS.Zone");

/** Suffix of generated zone names. */
const GENERATED_ZONE_SUFFIX = "runs.onstackit.cloud";

const DEFAULT_TYPE: ZoneType = "primary";

const isGone = (zone: dns.Zone | undefined) =>
  zone === undefined || zone.state === "DELETE_SUCCEEDED";

/** A zone update or delete failed; the zone still exists. */
const isFailedChange = (state: string) => state === "UPDATE_FAILED" || state === "DELETE_FAILED";

const resolveDnsName = (
  id: string,
  news: Pick<ZoneProps, "dnsName">,
  output: Pick<ZoneAttributes, "dnsName"> | undefined,
) =>
  Effect.gen(function* () {
    if (news.dnsName !== undefined) return normalizeDnsName(news.dnsName);
    if (output?.dnsName !== undefined) return output.dnsName;
    const label = yield* createPhysicalName({ id, lowercase: true, maxLength: 63 });
    return `${label}.${GENERATED_ZONE_SUFFIX}`;
  });

const toAttrs = (projectId: string, zone: dns.Zone): ZoneAttributes => ({
  zoneId: zone.id,
  projectId,
  dnsName: normalizeDnsName(zone.dnsName),
  name: zone.name,
  description: zone.description === "" ? undefined : zone.description,
  contactEmail: zone.contactEmail === "" ? undefined : zone.contactEmail,
  defaultTTL: zone.defaultTTL,
  refreshTime: zone.refreshTime,
  retryTime: zone.retryTime,
  expireTime: zone.expireTime,
  negativeCache: zone.negativeCache,
  type: zone.type,
  primaries: [...(zone.primaries ?? [])],
  isReverseZone: zone.isReverseZone ?? false,
  acl: zone.acl,
  observabilityInstanceId: zone.extensions?.observabilityExtension?.observabilityInstanceId,
  observabilityState: zone.extensions?.observabilityExtension?.state,
  primaryNameServer: zone.primaryNameServer,
  serialNumber: zone.serialNumber,
  state: zone.state,
  visibility: zone.visibility,
  active: zone.active ?? true,
  recordCount: zone.recordCount ?? 0,
  labels: stripInternalLabels(observedLabels(zone)),
});

/** Observed zone labels: `labelsMap`, falling back to the legacy list. */
const observedLabels = (zone: dns.Zone): Record<string, string> =>
  zone.labelsMap !== undefined ? labelRecord(zone.labelsMap) : labelRecord(zone.labels);

/** Every live zone in a project (soft-deleted zones are excluded by the API). */
const listProjectZones = (projectId: string) =>
  dns.listZones.items({ projectId, pageSize: 100 }).pipe(
    Stream.runCollect,
    Effect.map((zones) => [...zones].filter((zone) => zone.state !== "DELETE_SUCCEEDED")),
  );

const findZoneByDnsName = (projectId: string, dnsName: string) =>
  listProjectZones(projectId).pipe(
    Effect.map((zones) => zones.find((zone) => normalizeDnsName(zone.dnsName) === dnsName)),
  );

const findZoneByOwnership = (projectId: string, id: string) =>
  Effect.gen(function* () {
    const zones = yield* listProjectZones(projectId);
    for (const zone of zones) {
      if (yield* hasAlchemyLabels(id, observedLabels(zone))) return zone;
    }
    return undefined;
  });

/**
 * Wait until the zone reports success and `ready` holds. `UPDATE_FAILED`
 * only counts as a failure for an update started after `updateStartedBefore`
 * (the zone's `updateStarted` before our PATCH), so a stale failure from an
 * earlier deploy can't fail this one.
 */
const waitForZoneReady = (
  projectId: string,
  zoneId: string,
  ready: (zone: dns.Zone) => boolean,
  updateStartedBefore: string,
) =>
  waitFor({
    resource: `STACKIT DNS zone ${zoneId}`,
    read: dns.getZone({ projectId, zoneId }).pipe(Effect.map(({ zone }) => zone)),
    ready: (zone) => isSucceeded(zone.state) && ready(zone),
    failed: (zone) =>
      zone.state === "CREATE_FAILED" ||
      zone.state === "DELETE_SUCCEEDED" ||
      (zone.state === "UPDATE_FAILED" && zone.updateStarted !== updateStartedBefore)
        ? (zone.error ?? zone.state)
        : undefined,
    state: (zone) => zone.state,
    timeout: DNS_TIMEOUT,
  });

const waitForZoneGone = (projectId: string, zoneId: string) =>
  waitUntilGone({
    resource: `STACKIT DNS zone ${zoneId}`,
    read: getZoneOrUndefined(projectId, zoneId),
    failed: (zone) => (zone.state === "DELETE_FAILED" ? (zone.error ?? zone.state) : undefined),
    state: (zone) => zone.state,
    timeout: DNS_TIMEOUT,
  });

/** Delete a zone and wait until it is gone. Idempotent. */
const deleteZoneAndWait = (projectId: string, zoneId: string) =>
  Effect.gen(function* () {
    const current = yield* getZoneOrUndefined(projectId, zoneId);
    if (isGone(current)) return;
    if (current?.state !== "DELETING") {
      yield* dns
        .deleteZone({ projectId, zoneId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
    yield* waitForZoneGone(projectId, zoneId);
  });

/** The mutable aspects of a zone, as a `PartialUpdateZone` body. */
type ZonePatch = Omit<dns.PartialUpdateZoneRequest, "projectId" | "zoneId">;

/** The delta between an observed zone and the desired props (empty when in sync). */
const zoneDelta = (
  zone: dns.Zone,
  news: ZoneProps,
  dnsName: string,
  labels: Record<string, string>,
): ZonePatch => {
  const patch: ZonePatch = {};
  const name = news.name ?? dnsName;
  if (zone.name !== name) patch.name = name;
  if (news.description !== undefined && (zone.description ?? "") !== news.description) {
    patch.description = news.description;
  }
  if (news.contactEmail !== undefined && zone.contactEmail !== news.contactEmail) {
    patch.contactEmail = news.contactEmail;
  }
  if (news.defaultTTL !== undefined && zone.defaultTTL !== news.defaultTTL) {
    patch.defaultTTL = news.defaultTTL;
  }
  if (news.refreshTime !== undefined && zone.refreshTime !== news.refreshTime) {
    patch.refreshTime = news.refreshTime;
  }
  if (news.retryTime !== undefined && zone.retryTime !== news.retryTime) {
    patch.retryTime = news.retryTime;
  }
  if (news.expireTime !== undefined && zone.expireTime !== news.expireTime) {
    patch.expireTime = news.expireTime;
  }
  if (news.negativeCache !== undefined && zone.negativeCache !== news.negativeCache) {
    patch.negativeCache = news.negativeCache;
  }
  if (news.acl !== undefined && zone.acl !== news.acl) patch.acl = news.acl;
  if (
    news.observabilityInstanceId !== undefined &&
    zone.extensions?.observabilityExtension?.observabilityInstanceId !==
      news.observabilityInstanceId
  ) {
    patch.extensions = {
      observabilityExtension: { observabilityInstanceId: news.observabilityInstanceId },
    };
  }
  if (news.primaries !== undefined && !sameMembers(zone.primaries, news.primaries)) {
    patch.primaries = [...news.primaries];
  }
  // `labelsMap` carries the full desired set (user + ownership labels).
  if (!recordsEqual(observedLabels(zone), labels)) patch.labelsMap = labels;
  return patch;
};

export const ZoneProvider = () =>
  Provider.succeed(Zone, {
    stables: ["zoneId", "projectId", "dnsName", "type", "isReverseZone"],
    // Nuke ordering: `Stackit.DNS.RecordSet` declares
    // `dependsOn: ["Stackit.DNS.Zone"]`, so record sets go first.

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const zones = yield* listProjectZones(env.projectId);
      return zones
        .filter((zone) => isAlchemyOwned(observedLabels(zone)))
        .map((zone) => toAttrs(env.projectId, zone));
    }),

    diff: Effect.fn(function* ({ id, news, output }) {
      if (output === undefined) return undefined;
      // An unresolved identity can resolve to the name the zone already has,
      // and the same dnsName can't exist twice: delete the old zone first.
      if (
        hasUnresolvedTrigger<ZoneProps>(news, ["dnsName", "projectId", "type", "isReverseZone"])
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<ZoneProps>(news);
      const env = yield* StackitEnvironment.current;
      const projectId = resolved.projectId ?? env.projectId;
      const dnsName = yield* resolveDnsName(id, resolved, output);
      const sameName = dnsName === output.dnsName;
      if (
        !sameName ||
        projectId !== output.projectId ||
        (resolved.type ?? DEFAULT_TYPE) !== output.type ||
        (resolved.isReverseZone ?? false) !== output.isReverseZone
      ) {
        // The same dnsName can't exist twice: delete the old zone first.
        return { action: "replace", deleteFirst: sameName } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      let zone: dns.Zone | undefined;
      if (output?.zoneId !== undefined) {
        zone = yield* getZoneOrUndefined(projectId, output.zoneId);
      }
      const dnsName =
        output?.dnsName ??
        (olds?.dnsName !== undefined ? normalizeDnsName(olds.dnsName) : undefined);
      if (zone === undefined && dnsName !== undefined) {
        zone = yield* findZoneByDnsName(projectId, dnsName);
      }
      // A generated name with nothing recorded. Labels can't tell generations
      // apart, and garbage collection deletes the generation being replaced,
      // so a replacement only looks for its own (instance-id-bearing) name.
      // Otherwise it is a crashed create or lost state: find it by its labels.
      if (zone === undefined && output === undefined && olds?.dnsName === undefined) {
        if (previous !== undefined) {
          const generated = yield* resolveDnsName(id, {}, undefined);
          zone = yield* findZoneByDnsName(projectId, generated);
        } else {
          zone = yield* findZoneByOwnership(projectId, id);
        }
      }
      if (zone === undefined) return undefined;
      const attrs = toAttrs(projectId, zone);
      if (previous?.zoneId === zone.id) return attrs;
      return (yield* hasAlchemyLabels(id, observedLabels(zone))) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const dnsName = yield* resolveDnsName(id, news, output);
      const type = news.type ?? output?.type ?? DEFAULT_TYPE;
      const labels = yield* desiredLabels(id, news.labels);

      yield* ensureServiceEnabled({ projectId, region: env.region, serviceId: DNS_SERVICE_ID });

      // 1. Observe — by cached id, then by dnsName. `output` is a cache: the
      // recorded id only counts while it still names the desired zone.
      let zone: dns.Zone | undefined;
      if (output?.projectId === projectId && output.dnsName === dnsName) {
        zone = yield* getZoneOrUndefined(projectId, output.zoneId);
      }
      if (zone === undefined) zone = yield* findZoneByDnsName(projectId, dnsName);

      // A zone that never finished creating can't be repaired: recreate it.
      if (zone?.state === "CREATE_FAILED") {
        yield* deleteZoneAndWait(projectId, zone.id);
        zone = undefined;
      }
      // A delete in flight (e.g. an interrupted destroy): let it finish.
      if (zone?.state === "DELETING") {
        yield* waitForZoneGone(projectId, zone.id);
        zone = undefined;
      }

      // 2. Ensure
      if (zone === undefined) {
        const created = yield* dns
          .createZone({
            projectId,
            dnsName,
            name: news.name ?? dnsName,
            type,
            labelsMap: labels,
            ...(news.description !== undefined ? { description: news.description } : {}),
            ...(news.contactEmail !== undefined ? { contactEmail: news.contactEmail } : {}),
            ...(news.defaultTTL !== undefined ? { defaultTTL: news.defaultTTL } : {}),
            ...(news.refreshTime !== undefined ? { refreshTime: news.refreshTime } : {}),
            ...(news.retryTime !== undefined ? { retryTime: news.retryTime } : {}),
            ...(news.expireTime !== undefined ? { expireTime: news.expireTime } : {}),
            ...(news.negativeCache !== undefined ? { negativeCache: news.negativeCache } : {}),
            ...(news.acl !== undefined ? { acl: news.acl } : {}),
            ...(news.primaries !== undefined ? { primaries: [...news.primaries] } : {}),
            ...(news.isReverseZone !== undefined ? { isReverseZone: news.isReverseZone } : {}),
            ...(news.observabilityInstanceId !== undefined
              ? {
                  extensions: {
                    observabilityExtension: {
                      observabilityInstanceId: news.observabilityInstanceId,
                    },
                  },
                }
              : {}),
          })
          .pipe(
            Effect.map(({ zone }) => zone),
            // A concurrent create in this project won the race: observe it.
            // A zone of that name in another project still fails with Conflict.
            Effect.catchTag("Conflict", (error) =>
              findZoneByDnsName(projectId, dnsName).pipe(
                Effect.flatMap((found) =>
                  found === undefined ? Effect.fail(error) : Effect.succeed(found),
                ),
              ),
            ),
          );
        zone = created;
      }

      const zoneId = zone.id;

      // Wait out an in-flight create/update before syncing. A zone left in
      // UPDATE_FAILED / DELETE_FAILED is synced as is: a PATCH below re-applies
      // the desired state.
      if (zone.state === "CREATING" || zone.state === "UPDATING") {
        zone = yield* waitFor({
          resource: `STACKIT DNS zone ${zoneId}`,
          read: dns.getZone({ projectId, zoneId }).pipe(Effect.map(({ zone }) => zone)),
          ready: (observed) => observed.state !== "CREATING" && observed.state !== "UPDATING",
          failed: (observed) =>
            observed.state === "CREATE_FAILED" || observed.state === "DELETE_SUCCEEDED"
              ? (observed.error ?? observed.state)
              : undefined,
          state: (observed) => observed.state,
          timeout: DNS_TIMEOUT,
        });
      }

      // 3. Sync — one PATCH carrying every drifted aspect, diffed against
      // the observed zone (labels against observed labels). A failed zone is
      // patched even with nothing drifted, so it either recovers or the deploy
      // fails; it is never returned as if it were healthy.
      const delta = zoneDelta(zone, news, dnsName, labels);
      const patch: ZonePatch =
        Object.keys(delta).length === 0 && isFailedChange(zone.state) ? { name: zone.name } : delta;
      if (Object.keys(patch).length > 0) {
        const updateStartedBefore = zone.updateStarted;
        yield* dns.partialUpdateZone({ projectId, zoneId, ...patch });
        // PATCH is asynchronous: wait until the zone reports success with
        // the desired values, so a stale pre-update read can't pass.
        // Label removals aren't awaited (only that every desired label is
        // present), so a PATCH that merges `labelsMap` can't stall the deploy.
        zone = yield* waitForZoneReady(
          projectId,
          zoneId,
          (observed) => {
            const { labelsMap, ...rest } = zoneDelta(observed, news, dnsName, labels);
            const observedLabelMap = observedLabels(observed);
            return (
              Object.keys(rest).length === 0 &&
              (labelsMap === undefined ||
                Object.entries(labels).every(([key, value]) => observedLabelMap[key] === value))
            );
          },
          updateStartedBefore,
        );
      }

      // The zone can report success while its log export is still starting,
      // or after it failed.
      const exportState = zone.extensions?.observabilityExtension?.state;
      if (
        news.observabilityInstanceId !== undefined &&
        (exportState === "CREATING" || exportState === "ERROR")
      ) {
        zone = yield* waitFor({
          resource: `STACKIT DNS zone ${zoneId} log export`,
          read: dns.getZone({ projectId, zoneId }).pipe(Effect.map(({ zone }) => zone)),
          ready: (observed) => observed.extensions?.observabilityExtension?.state !== "CREATING",
          failed: (observed) =>
            observed.extensions?.observabilityExtension?.state === "ERROR" ? "ERROR" : undefined,
          state: (observed) => observed.extensions?.observabilityExtension?.state,
          timeout: DNS_TIMEOUT,
        });
      }

      // 4. Return
      return toAttrs(projectId, zone);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteZoneAndWait(output.projectId, output.zoneId);
    }),
  });
