import * as dns from "@distilled.cloud/stackit/dns";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger } from "../internal/diff.ts";
import { sameMembers } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import { isAlchemyOwned, labelRecord } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DNS_TIMEOUT,
  getRecordSetOrUndefined,
  getZoneOrUndefined,
  isSucceeded,
  normalizeDnsName,
} from "./internal.ts";

/** DNS record type of a STACKIT record set. */
export type RecordSetType = dns.RecordSetType | (string & {});

export interface RecordSetProps {
  /**
   * Id of the zone the record set lives in, usually `zone.zoneId` of a
   * `Stackit.DNS.Zone`. Changing it replaces the record set.
   */
  zoneId: string;
  /**
   * Record name, relative to the zone (`www`, `_acme-challenge.api`) or
   * fully qualified (`www.example.com`). Use the zone's `dnsName` for a
   * record at the zone apex. A trailing dot is ignored. Changing it replaces
   * the record set.
   *
   * If omitted, a unique label is generated from the stack, stage and
   * logical ID.
   */
  name?: string;
  /**
   * DNS record type (`A`, `AAAA`, `CNAME`, `MX`, `TXT`, `SRV`, `CAA`, ...).
   * Every value in `records` has this type. Changing it replaces the record
   * set.
   */
  type: RecordSetType;
  /**
   * Record contents, one entry per record: an IPv4 address for `A`, a host
   * name for `CNAME`, `"10 mail.example.com."` for `MX`, and so on. Must be
   * non-empty; order is not significant. Updates in place.
   */
  records: string[];
  /**
   * TTL in seconds. Updates in place; omit to use the zone's `defaultTTL`
   * on create and leave the live value alone on update.
   */
  ttl?: number;
  /**
   * Free-form comment shown in the STACKIT portal; it doesn't affect DNS
   * answers. Updates in place; omitting it clears the comment.
   */
  comment?: string;
  /**
   * Project that owns the zone. Defaults to the profile's project. Pass
   * `zone.projectId` when the zone lives elsewhere. Changing it replaces
   * the record set.
   */
  projectId?: string;
}

export interface RecordSetAttributes {
  /** STACKIT record set id (UUID). Stable across updates. */
  rrSetId: string;
  /** Id of the zone the record set lives in. */
  zoneId: string;
  /** Project that owns the zone. */
  projectId: string;
  /** DNS name of the zone, without a trailing dot. */
  zoneDnsName: string;
  /** Record name as requested (relative or fully qualified, no trailing dot). */
  name: string;
  /** Fully qualified record name, without a trailing dot. */
  fqdn: string;
  /** DNS record type. */
  type: RecordSetType;
  /** Record contents currently published, sorted. */
  records: string[];
  /** TTL in seconds. */
  ttl: number;
  /** Comment, if any. */
  comment: string | undefined;
  /** Record set state; `CREATE_SUCCEEDED` or `UPDATE_SUCCEEDED` after a deploy. */
  state: string;
  /** Whether the record set is active. */
  active: boolean;
}

export type RecordSet = Resource<
  "Stackit.DNS.RecordSet",
  RecordSetProps,
  RecordSetAttributes,
  never,
  Providers
>;

/**
 * A STACKIT DNS record set: every record of one name and type in a
 * `Stackit.DNS.Zone`. Two `A` addresses for `www` are one record set, not
 * two resources.
 *
 * Identity is the zone, name and type: changing any of them (or the
 * `projectId`) replaces the record set. Records, TTL and comment update in
 * place. Changes are asynchronous on STACKIT; deploys wait until the record
 * set reports `CREATE_SUCCEEDED` / `UPDATE_SUCCEEDED` with the desired
 * records, and destroys wait until it is gone.
 *
 * Ownership: STACKIT record sets carry no labels, and Alchemy keeps its
 * markers out of the user-visible `comment`. A record set Alchemy created is
 * tracked by its id in state. A record set found only by name and type, with
 * no id in state, is reported as unowned and only taken over with
 * `--adopt`. `alchemy unsafe nuke` enumerates the record sets of zones that
 * carry Alchemy's ownership labels, skipping the `SOA` and apex `NS`
 * records STACKIT manages.
 *
 * ### Creating a Record Set
 * **Example:** A records for `www`
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const zone = yield* Stackit.DNS.Zone("Zone", { dnsName: "example.com" });
 * const www = yield* Stackit.DNS.RecordSet("Www", {
 *   zoneId: zone.zoneId,
 *   name: "www",
 *   type: "A",
 *   records: ["192.0.2.10", "192.0.2.11"],
 *   ttl: 300,
 * });
 * ```
 *
 * **Example:** Record at the zone apex
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const zone = yield* Stackit.DNS.Zone("Zone", { dnsName: "example.com" });
 * yield* Stackit.DNS.RecordSet("Apex", {
 *   zoneId: zone.zoneId,
 *   name: zone.dnsName,
 *   type: "A",
 *   records: ["192.0.2.10"],
 * });
 * ```
 *
 * ### Common Record Types
 * **Example:** CNAME, MX and TXT records
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const zone = yield* Stackit.DNS.Zone("Zone", { dnsName: "example.com" });
 * yield* Stackit.DNS.RecordSet("Docs", {
 *   zoneId: zone.zoneId,
 *   name: "docs",
 *   type: "CNAME",
 *   records: ["www.example.com."],
 * });
 * yield* Stackit.DNS.RecordSet("Mail", {
 *   zoneId: zone.zoneId,
 *   name: zone.dnsName,
 *   type: "MX",
 *   records: ["10 mx1.example.com.", "20 mx2.example.com."],
 * });
 * yield* Stackit.DNS.RecordSet("Verify", {
 *   zoneId: zone.zoneId,
 *   name: "_verify",
 *   type: "TXT",
 *   records: ['"site-verification=abc123"'],
 *   comment: "domain ownership check",
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Changing the type replaces the record set
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const zone = yield* Stackit.DNS.Zone("Zone", { dnsName: "example.com" });
 * // Switching www from A to CNAME deletes the A record set first (a CNAME
 * // can't coexist with other records of the same name), so www briefly
 * // has no answer during the deploy.
 * yield* Stackit.DNS.RecordSet("Www", {
 *   zoneId: zone.zoneId,
 *   name: "www",
 *   type: "CNAME",
 *   records: ["lb.example.net."],
 * });
 * ```
 *
 * @resource
 * @product STACKIT DNS
 * @category DNS
 */
export const RecordSet = Resource<RecordSet>("Stackit.DNS.RecordSet");

/** The zone of a record set no longer exists (or is being deleted). */
export class RecordSetZoneNotFound extends Data.TaggedError("Stackit.DNS.RecordSetZoneNotFound")<{
  readonly projectId: string;
  readonly zoneId: string;
  readonly message: string;
}> {}

/** Labels are at most 63 characters (RFC 1035). */
const NAME_MAX_LENGTH = 63;

/** Record types STACKIT creates and manages for every zone. */
const MANAGED_APEX_TYPES = new Set(["SOA", "NS"]);

/** Fully qualified form of a record name (relative or FQDN) in a zone. */
const fqdnOf = (name: string, zoneDnsName: string): string => {
  const record = normalizeDnsName(name);
  const zone = normalizeDnsName(zoneDnsName);
  return record === zone || record.endsWith(`.${zone}`) ? record : `${record}.${zone}`;
};

const resolveName = (
  id: string,
  news: Pick<RecordSetProps, "name">,
  output: Pick<RecordSetAttributes, "name"> | undefined,
) =>
  Effect.gen(function* () {
    if (news.name !== undefined) return normalizeDnsName(news.name);
    if (output?.name !== undefined) return output.name;
    return yield* createPhysicalName({ id, lowercase: true, maxLength: NAME_MAX_LENGTH });
  });

const contentsOf = (rrset: dns.RecordSet): string[] =>
  rrset.records.map((record) => record.content).sort();

const toAttrs = (
  projectId: string,
  zoneId: string,
  zoneDnsName: string,
  name: string,
  rrset: dns.RecordSet,
): RecordSetAttributes => ({
  rrSetId: rrset.id,
  zoneId,
  projectId,
  zoneDnsName: normalizeDnsName(zoneDnsName),
  name,
  fqdn: normalizeDnsName(rrset.name),
  type: rrset.type,
  records: contentsOf(rrset),
  ttl: rrset.ttl,
  comment: rrset.comment === "" ? undefined : rrset.comment,
  state: rrset.state,
  active: rrset.active ?? true,
});

/** Find a live record set by fully qualified name and type. */
const findRecordSet = (projectId: string, zoneId: string, fqdn: string, type: string) =>
  dns.listRecordSets.items({ projectId, zoneId, type_eq_: type, pageSize: 100 }).pipe(
    Stream.filter(
      (rrset) =>
        rrset.state !== "DELETE_SUCCEEDED" &&
        rrset.type === type &&
        normalizeDnsName(rrset.name) === fqdn,
    ),
    Stream.runHead,
    Effect.map((option) => (option._tag === "Some" ? option.value : undefined)),
  );

/** The zone's DNS name, failing with a typed error when the zone is gone. */
const requireZoneDnsName = (projectId: string, zoneId: string) =>
  getZoneOrUndefined(projectId, zoneId).pipe(
    Effect.flatMap((zone) =>
      zone === undefined || zone.state === "DELETING"
        ? Effect.fail(
            new RecordSetZoneNotFound({
              projectId,
              zoneId,
              message: `STACKIT DNS zone ${zoneId} not found in project ${projectId}`,
            }),
          )
        : Effect.succeed(zone.dnsName),
    ),
  );

interface DesiredRecordSet {
  readonly records: ReadonlyArray<string>;
  readonly ttl: number | undefined;
  readonly comment: string;
}

/** The mutable aspects that differ between the observed and desired record set. */
const recordSetDelta = (rrset: dns.RecordSet, desired: DesiredRecordSet) => {
  const patch: { records?: dns.RecordPayload[]; ttl?: number; comment?: string } = {};
  if (!sameMembers(contentsOf(rrset), desired.records)) {
    patch.records = desired.records.map((content) => ({ content }));
  }
  if (desired.ttl !== undefined && rrset.ttl !== desired.ttl) patch.ttl = desired.ttl;
  if ((rrset.comment ?? "") !== desired.comment) patch.comment = desired.comment;
  return patch;
};

const describeRecordSet = (rrSetId: string) => `STACKIT DNS record set ${rrSetId}`;

/**
 * Wait until the record set reports success and `ready` holds. A failure
 * state only counts when its update started after `updateStartedBefore`,
 * so a stale failure from an earlier deploy can't fail this one.
 */
const waitForRecordSetReady = (
  projectId: string,
  zoneId: string,
  rrSetId: string,
  ready: (rrset: dns.RecordSet) => boolean,
  updateStartedBefore: string | undefined,
) =>
  waitFor({
    resource: describeRecordSet(rrSetId),
    read: dns.getRecordSet({ projectId, zoneId, rrSetId }).pipe(Effect.map(({ rrset }) => rrset)),
    ready: (rrset) => isSucceeded(rrset.state) && ready(rrset),
    failed: (rrset) =>
      rrset.state === "CREATE_FAILED" ||
      rrset.state === "DELETE_SUCCEEDED" ||
      (rrset.state === "UPDATE_FAILED" && rrset.updateStarted !== updateStartedBefore)
        ? (rrset.error ?? rrset.state)
        : undefined,
    state: (rrset) => rrset.state,
    timeout: DNS_TIMEOUT,
  });

/** Delete a record set and wait until it is gone. Idempotent. */
const deleteRecordSetAndWait = (projectId: string, zoneId: string, rrSetId: string) =>
  Effect.gen(function* () {
    const current = yield* getRecordSetOrUndefined(projectId, zoneId, rrSetId);
    if (current === undefined) return;
    if (current.state !== "DELETING") {
      yield* dns
        .deleteRecordSet({ projectId, zoneId, rrSetId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
    yield* waitUntilGone({
      resource: describeRecordSet(rrSetId),
      read: getRecordSetOrUndefined(projectId, zoneId, rrSetId),
      failed: (rrset) =>
        rrset.state === "DELETE_FAILED" ? (rrset.error ?? rrset.state) : undefined,
      state: (rrset) => rrset.state,
      timeout: DNS_TIMEOUT,
    });
  });

export const RecordSetProvider = () =>
  Provider.succeed(RecordSet, {
    stables: ["rrSetId", "zoneId", "projectId", "zoneDnsName", "name", "fqdn", "type"],
    nuke: { dependsOn: ["Stackit.DNS.Zone"] },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const projectId = env.projectId;
      const zones = yield* dns.listZones
        .items({ projectId, pageSize: 100 })
        .pipe(Stream.runCollect);
      const owned = [...zones].filter(
        (zone) =>
          zone.state !== "DELETE_SUCCEEDED" &&
          isAlchemyOwned(labelRecord(zone.labelsMap ?? zone.labels)),
      );
      const rows = yield* Effect.forEach(
        owned,
        (zone) =>
          dns.listRecordSets.items({ projectId, zoneId: zone.id, pageSize: 100 }).pipe(
            Stream.runCollect,
            Effect.map((rrsets) =>
              [...rrsets]
                .filter(
                  (rrset) =>
                    rrset.state !== "DELETE_SUCCEEDED" &&
                    !(
                      MANAGED_APEX_TYPES.has(rrset.type) &&
                      normalizeDnsName(rrset.name) === normalizeDnsName(zone.dnsName)
                    ),
                )
                .map((rrset) =>
                  toAttrs(projectId, zone.id, zone.dnsName, normalizeDnsName(rrset.name), rrset),
                ),
            ),
          ),
        { concurrency: 4 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // A record set has no generation marker, and an unresolved prop can
      // resolve to the name and type it already has: the old one goes first.
      if (hasUnresolvedTrigger<RecordSetProps>(news, ["projectId", "zoneId", "name", "type"])) {
        return { action: "replace", deleteFirst: true } as const;
      }
      if (!isResolved(news)) return undefined;
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? env.projectId;
      const sameZone = news.zoneId === output.zoneId && projectId === output.projectId;
      const sameName =
        news.name === undefined || fqdnOf(news.name, output.zoneDnsName) === output.fqdn;
      if (!sameZone || !sameName || news.type !== output.type) {
        // Same name in the same zone (a type change): delete first, since a
        // CNAME can't coexist with other records of that name.
        return { action: "replace", deleteFirst: sameZone && sameName } as const;
      }
      // Records, TTL and comment update in place (engine default).
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output, previous }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const zoneId = output?.zoneId ?? olds?.zoneId;
      if (zoneId === undefined) return undefined;

      // Tracked in state: ours.
      if (output?.rrSetId !== undefined) {
        const rrset = yield* getRecordSetOrUndefined(projectId, zoneId, output.rrSetId);
        if (rrset !== undefined) {
          return toAttrs(projectId, zoneId, output.zoneDnsName, output.name, rrset);
        }
      }

      // Not in state: look it up by name and type.
      const type = output?.type ?? olds?.type;
      const rawName = output?.name ?? olds?.name;
      if (type === undefined || rawName === undefined) return undefined;
      const zone = yield* getZoneOrUndefined(projectId, zoneId);
      if (zone === undefined) return undefined;
      const name = normalizeDnsName(rawName);
      const rrset = yield* findRecordSet(projectId, zoneId, fqdnOf(name, zone.dnsName), type);
      if (rrset === undefined) return undefined;
      const attrs = toAttrs(projectId, zoneId, zone.dnsName, name, rrset);
      // No labels on record sets: one found without a recorded id may be
      // foreign (see the resource docs). With an id in state, or as the
      // generation being replaced, the record of that name and type is the
      // one Alchemy manages.
      return output !== undefined || previous?.rrSetId === rrset.id ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const zoneId = news.zoneId;
      const name = yield* resolveName(id, news, output);
      const type = news.type;
      const desired: DesiredRecordSet = {
        records: news.records,
        ttl: news.ttl,
        comment: news.comment ?? "",
      };

      // 1. Observe — the zone (for the FQDN), then the record set by cached
      // id, then by name and type.
      const zoneDnsName = yield* requireZoneDnsName(projectId, zoneId);
      const fqdn = fqdnOf(name, zoneDnsName);
      let rrset: dns.RecordSet | undefined;
      if (output?.rrSetId !== undefined && output.zoneId === zoneId) {
        rrset = yield* getRecordSetOrUndefined(projectId, zoneId, output.rrSetId);
        // A cached id whose name/type no longer match is a different record.
        if (rrset !== undefined && (rrset.type !== type || normalizeDnsName(rrset.name) !== fqdn)) {
          rrset = undefined;
        }
      }
      if (rrset === undefined) rrset = yield* findRecordSet(projectId, zoneId, fqdn, type);

      // A record set that never finished creating can't be repaired: recreate it.
      if (rrset?.state === "CREATE_FAILED") {
        yield* deleteRecordSetAndWait(projectId, zoneId, rrset.id);
        rrset = undefined;
      }
      if (rrset?.state === "DELETING") {
        yield* deleteRecordSetAndWait(projectId, zoneId, rrset.id);
        rrset = undefined;
      }

      // 2. Ensure
      if (rrset === undefined) {
        rrset = yield* dns
          .createRecordSet({
            projectId,
            zoneId,
            name,
            type,
            records: desired.records.map((content) => ({ content })),
            ...(desired.ttl !== undefined ? { ttl: desired.ttl } : {}),
            ...(desired.comment !== "" ? { comment: desired.comment } : {}),
          })
          .pipe(
            Effect.map(({ rrset }) => rrset),
            // A concurrent create won the race: observe it.
            Effect.catchTag("Conflict", (error) =>
              findRecordSet(projectId, zoneId, fqdn, type).pipe(
                Effect.flatMap((found) =>
                  found === undefined ? Effect.fail(error) : Effect.succeed(found),
                ),
              ),
            ),
          );
      }

      const rrSetId = rrset.id;

      // Wait out an in-flight create/update before syncing.
      if (rrset.state === "CREATING" || rrset.state === "UPDATING") {
        rrset = yield* waitFor({
          resource: describeRecordSet(rrSetId),
          read: dns
            .getRecordSet({ projectId, zoneId, rrSetId })
            .pipe(Effect.map(({ rrset }) => rrset)),
          ready: (observed) => observed.state !== "CREATING" && observed.state !== "UPDATING",
          failed: (observed) =>
            observed.state === "CREATE_FAILED" || observed.state === "DELETE_SUCCEEDED"
              ? (observed.error ?? observed.state)
              : undefined,
          state: (observed) => observed.state,
          timeout: DNS_TIMEOUT,
        });
      }

      // 3. Sync — records, TTL and comment against the observed record set. A
      // failed record set is patched even with nothing drifted, so it either
      // recovers or the deploy fails; it is never returned as if it were healthy.
      const delta = recordSetDelta(rrset, desired);
      const patch: ReturnType<typeof recordSetDelta> =
        Object.keys(delta).length === 0 &&
        (rrset.state === "UPDATE_FAILED" || rrset.state === "DELETE_FAILED")
          ? { records: desired.records.map((content) => ({ content })) }
          : delta;
      if (Object.keys(patch).length > 0) {
        const updateStartedBefore = rrset.updateStarted;
        yield* dns.partialUpdateRecordSet({ projectId, zoneId, rrSetId, ...patch });
        // PATCH is asynchronous and returns no record set: wait until the
        // observed record set carries the desired values. A cleared comment
        // isn't awaited, so an API that ignores an empty comment can't stall
        // the deploy (the next deploy re-sends it).
        rrset = yield* waitForRecordSetReady(
          projectId,
          zoneId,
          rrSetId,
          (observed) => {
            const { comment, ...rest } = recordSetDelta(observed, desired);
            return Object.keys(rest).length === 0 && (comment === undefined || comment === "");
          },
          updateStartedBefore,
        );
      }

      // 4. Return
      return toAttrs(projectId, zoneId, zoneDnsName, name, rrset);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteRecordSetAndWait(output.projectId, output.zoneId, output.rrSetId);
    }),
  });
