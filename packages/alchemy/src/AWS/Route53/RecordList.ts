import * as route53 from "@distilled.cloud/aws/route-53";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { DnsRecord, DnsRecordType } from "../../DNS/Adapter.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { resolveHostedZoneId } from "./HostedZoneLookup.ts";
import { normalizeHostedZoneId } from "./Record.ts";

export interface RecordListProps {
  /**
   * Hosted zone that owns every record. When omitted, each record's zone
   * is the most specific PUBLIC hosted zone in the account containing its
   * name, so one list may span several zones (e.g. certificate validation
   * records for `example.com` and `example.org`).
   */
  hostedZoneId?: string;
  /**
   * Records to publish.
   *
   * - `CNAME` — the record set at the name is overwritten (`UPSERT`).
   * - `A` / `AAAA` — the name's record set of that type holds exactly the
   *   listed values.
   * - `TXT` — the listed values are merged into the name's TXT record set,
   *   alongside values published by anyone else.
   */
  records: DnsRecord[];
}

/** One record published by a {@link RecordList}. */
export interface RecordListEntry {
  /** Hosted zone the record lives in. */
  hostedZoneId: string;
  /** Normalized record name (lowercase, no trailing dot). */
  name: string;
  /** Record type. */
  type: DnsRecordType;
  /** Normalized record value (TXT values unquoted). */
  value: string;
  /** TTL in seconds. */
  ttl: number;
}

export interface RecordList extends Resource<
  "AWS.Route53.RecordList",
  RecordListProps,
  {
    /** Every record this list currently publishes. */
    records: RecordListEntry[];
  },
  never,
  Providers
> {}

/**
 * An explicit list of Route 53 records whose values are typically computed
 * from another resource's outputs — ACM certificate validation CNAMEs, a
 * platform's ownership-verification TXT, a Fly App's addresses.
 *
 * This is the resource an `AWS.Route53.Adapter()` declares for
 * `domain.dns` record publication (see
 * [DNS Adapters](/infrastructure-as-code/dns-adapters)). Each record's
 * hosted zone is inferred from its name unless `hostedZoneId` is set, and
 * only the values the list published are removed when they leave the list
 * or the list is destroyed.
 * ### Publishing Records
 * **Example:** Verification TXT For A Railway Domain
 * ```typescript
 * yield* AWS.Route53.RecordList("Verify", {
 *   records: [
 *     {
 *       name: "_railway-verify.app.example.com",
 *       type: "TXT",
 *       value: "railway-verify=abc123",
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const RecordList = Resource<RecordList>("AWS.Route53.RecordList");

const DEFAULT_TTL = 300;

const normalizeName = (name: string) => name.replace(/\.$/, "").toLowerCase();

const unquote = (value: string) => value.replace(/^"|"$/g, "");

const normalizeValue = (type: DnsRecordType, value: string) =>
  type === "TXT" ? unquote(value) : normalizeName(value);

const toWire = (type: DnsRecordType, value: string) =>
  type === "TXT" ? `"${value}"` : value;

const keyOf = (entry: RecordListEntry) =>
  `${entry.hostedZoneId}|${entry.name}|${entry.type}|${entry.value}`;

const groupKeyOf = (entry: {
  hostedZoneId: string;
  name: string;
  type: string;
}) => `${entry.hostedZoneId}|${entry.name}|${entry.type}`;

const waitForChange = (changeId: string) =>
  route53.getChange({ Id: changeId.replace(/^\/change\//, "") }).pipe(
    Effect.map((response) => response.ChangeInfo.Status),
    Effect.catchTag("NoSuchChange", () => Effect.succeed("PENDING" as const)),
    Effect.repeat({
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(60),
      ]),
      until: (status) => status === "INSYNC",
    }),
  );

const findRecordSet = (
  hostedZoneId: string,
  name: string,
  type: DnsRecordType,
) =>
  route53
    .listResourceRecordSets({
      HostedZoneId: normalizeHostedZoneId(hostedZoneId),
      StartRecordName: `${name}.`,
      StartRecordType: type,
      MaxItems: 10,
    })
    .pipe(
      Effect.map((response) =>
        (response.ResourceRecordSets ?? []).find(
          (recordSet) =>
            normalizeName(recordSet.Name) === name &&
            recordSet.Type === type &&
            recordSet.SetIdentifier === undefined &&
            recordSet.AliasTarget === undefined,
        ),
      ),
      Effect.catchTag("NoSuchHostedZone", () => Effect.succeed(undefined)),
    );

const liveValuesOf = (
  type: DnsRecordType,
  recordSet: route53.ResourceRecordSet | undefined,
) =>
  (recordSet?.ResourceRecords ?? []).map((record) =>
    normalizeValue(type, record.Value),
  );

const sameValues = (a: string[], b: string[]) =>
  a.length === b.length &&
  [...a].sort().every((value, index) => value === [...b].sort()[index]);

/**
 * Converge one `(zone, name, type)` record set: `desired` are the values
 * this list publishes there now, `previous` the values it published
 * before (removed unless still desired).
 */
const syncRecordSet = (
  hostedZoneId: string,
  name: string,
  type: DnsRecordType,
  desired: RecordListEntry[],
  previous: RecordListEntry[],
) =>
  Effect.gen(function* () {
    const live = yield* findRecordSet(hostedZoneId, name, type);
    const liveValues = liveValuesOf(type, live);
    const desiredValues = desired.map((entry) => entry.value);
    const removed = new Set(
      previous
        .map((entry) => entry.value)
        .filter((value) => !desiredValues.includes(value)),
    );
    const values =
      type === "TXT"
        ? [
            ...new Set([
              ...liveValues.filter((value) => !removed.has(value)),
              ...desiredValues,
            ]),
          ]
        : type === "CNAME"
          ? desiredValues.slice(-1)
          : [...new Set(desiredValues)];
    const ttl = desired[0]?.ttl ?? live?.TTL ?? DEFAULT_TTL;

    let change: route53.Change | undefined;
    if (values.length === 0) {
      // Nothing of ours (or anyone's, for TXT) remains: delete what we own.
      const ours =
        live !== undefined &&
        (type === "TXT" || liveValues.every((value) => removed.has(value)));
      if (ours) change = { Action: "DELETE", ResourceRecordSet: live };
    } else if (
      live === undefined ||
      !sameValues(liveValues, values) ||
      live.TTL !== ttl
    ) {
      change = {
        Action: "UPSERT",
        ResourceRecordSet: {
          Name: `${name}.`,
          Type: type,
          TTL: ttl,
          ResourceRecords: values.map((value) => ({
            Value: toWire(type, value),
          })),
        },
      };
    }
    if (change === undefined) return;
    const response = yield* route53
      .changeResourceRecordSets({
        HostedZoneId: normalizeHostedZoneId(hostedZoneId),
        ChangeBatch: {
          Comment: "Alchemy Route53 record list",
          Changes: [change],
        },
      })
      .pipe(
        Effect.catchTag("InvalidChangeBatch", (error) =>
          // A DELETE racing another writer is benign; anything else isn't.
          change?.Action === "DELETE"
            ? Effect.succeed(undefined)
            : Effect.fail(error),
        ),
      );
    if (response !== undefined) {
      yield* waitForChange(response.ChangeInfo.Id);
    }
  });

const groupBy = (entries: RecordListEntry[]) => {
  const groups = new Map<string, RecordListEntry[]>();
  for (const entry of entries) {
    const key = groupKeyOf(entry);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return groups;
};

export const RecordListProvider = () =>
  Provider.succeed(RecordList, {
    // No `diff`: every change (records, a pinned zone moving) converges in
    // place — reconcile removes values the list no longer publishes.
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const present = yield* Effect.forEach(output.records, (entry) =>
        findRecordSet(entry.hostedZoneId, entry.name, entry.type).pipe(
          Effect.map((live) =>
            liveValuesOf(entry.type, live).includes(entry.value) ? [entry] : [],
          ),
        ),
      );
      return { records: present.flat() };
    }),

    reconcile: Effect.fn(function* ({ news, output, session }) {
      const zoneCache = new Map<string, string>();
      const desiredByKey = new Map<string, RecordListEntry>();
      for (const record of news.records) {
        const name = normalizeName(record.name);
        let hostedZoneId = zoneCache.get(name);
        if (hostedZoneId === undefined) {
          hostedZoneId = normalizeHostedZoneId(
            yield* resolveHostedZoneId(news.hostedZoneId, name),
          );
          zoneCache.set(name, hostedZoneId);
        }
        const entry: RecordListEntry = {
          hostedZoneId,
          name,
          type: record.type,
          value: normalizeValue(record.type, record.value),
          ttl: record.ttl ?? DEFAULT_TTL,
        };
        desiredByKey.set(keyOf(entry), entry);
      }
      const desired = [...desiredByKey.values()];
      const desiredGroups = groupBy(desired);
      const previousGroups = groupBy(output?.records ?? []);

      for (const key of new Set([
        ...desiredGroups.keys(),
        ...previousGroups.keys(),
      ])) {
        const group = desiredGroups.get(key) ?? [];
        const previous = previousGroups.get(key) ?? [];
        const sample = group[0] ?? previous[0];
        yield* syncRecordSet(
          sample.hostedZoneId,
          sample.name,
          sample.type,
          group,
          previous,
        );
      }

      yield* session.note(`${desired.length} record(s)`);
      return { records: desired };
    }),

    delete: Effect.fn(function* ({ output }) {
      for (const previous of groupBy(output.records).values()) {
        const sample = previous[0];
        yield* syncRecordSet(
          sample.hostedZoneId,
          sample.name,
          sample.type,
          [],
          previous,
        );
      }
    }),
  });
