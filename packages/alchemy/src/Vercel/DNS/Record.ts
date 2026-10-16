import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { Client, type VercelClient, type VercelTeamScope } from "../Client.ts";
import { VercelError, VercelNotFound } from "../Errors.ts";
import type { Providers } from "../Providers.ts";

/**
 * DNS record type literal — every value the Vercel API accepts on create.
 * Changing it replaces the record because type is part of a record's identity.
 */
export type RecordType =
  | "A"
  | "AAAA"
  | "ALIAS"
  | "CAA"
  | "CNAME"
  | "HTTPS"
  | "MX"
  | "NS"
  | "SRV"
  | "TXT"
  | (string & {});

export interface RecordProps {
  /**
   * Domain (zone apex) the record lives in, e.g. `example.com`.
   * Changing it replaces the record.
   */
  domain: string;
  /**
   * Subdomain portion of the record name, or `""` for the apex.
   * Lowercased and trailing-dot stripped. Changing it replaces the record.
   *
   * If omitted, a unique label is generated from the stack, stage, and
   * logical ID.
   */
  name?: string;
  /**
   * DNS record type. Changing it replaces the record.
   */
  type: RecordType;
  /**
   * Record value (IP address, hostname, or text depending on `type`).
   * Mutable — updates in place.
   */
  value: string;
  /**
   * TTL in seconds (`60`–`2147483647`). Omit for the Vercel default (60).
   * Mutable — updates in place.
   */
  ttl?: number;
  /**
   * Team that owns the domain. Defaults to the ambient credentials'
   * team scope. Changing it replaces the record.
   */
  teamId?: string;
  /**
   * Team slug alternative to `teamId`. Defaults to the ambient
   * credentials' team scope.
   */
  teamSlug?: string;
}

export interface RecordAttributes {
  /**
   * Vercel record id (`rec_…`). Stable across updates.
   */
  id: string;
  /**
   * Domain (zone apex) the record lives in.
   */
  domain: string;
  /**
   * Subdomain portion of the record name (`""` for the apex).
   */
  name: string;
  /**
   * DNS record type.
   */
  type: string;
  /**
   * Record value.
   */
  value: string;
  /**
   * TTL in seconds.
   */
  ttl: number | undefined;
}

export type Record = Resource<
  "Vercel.Record",
  RecordProps,
  RecordAttributes,
  never,
  Providers
>;

/**
 * A Vercel DNS record — one `(domain, name, type)` with a single value.
 *
 * Identity is `(domain, name, type)`: changing any of those replaces the
 * record. Value and TTL update in place.
 *
 * @see https://vercel.com/docs/rest-api/dns/create-a-dns-record
 *
 * ### Creating a record
 * ```typescript
 * const preview = yield* Vercel.Record("preview-cname", {
 *   domain: "example.com",
 *   name: "preview",
 *   type: "CNAME",
 *   value: "d111111abcdef8.cloudfront.net",
 * });
 * ```
 *
 * @resource
 * @product DNS
 */
export const Record = Resource<Record>("Vercel.Record");

export class RecordDomainMissing extends Data.TaggedError(
  "Vercel.RecordDomainMissing",
)<{
  name: string;
  type: string;
}> {}

class RecordStillExists extends Data.TaggedError("RecordStillExists")<{
  domain: string;
  name: string;
  type: string;
}> {}

interface WireRecord {
  readonly id?: string;
  readonly uid?: string;
  readonly name?: string;
  readonly type?: string;
  readonly value?: string;
  readonly ttl?: number;
}

export const normalizeName = (name: string): string =>
  name.toLowerCase().replace(/\.$/, "");

export const normalizeType = (type: string): string => type.toUpperCase();

const toAttrs = (domain: string, record: WireRecord): RecordAttributes => ({
  id: record.uid ?? record.id ?? `${domain}/${record.name}/${record.type}`,
  domain,
  name: record.name ?? "",
  type: record.type ?? "",
  value: record.value ?? "",
  ttl: record.ttl,
});

const backoff = Schedule.min([
  Schedule.exponential(Duration.millis(500), 1.5),
  Schedule.spaced(Duration.seconds(5)),
]);

const listRecords = (
  client: VercelClient,
  domain: string,
  scope: VercelTeamScope,
) =>
  Effect.gen(function* () {
    const records: WireRecord[] = [];
    let since: number | undefined;
    for (let page = 0; page < 25; page++) {
      const params = new URLSearchParams({ limit: "100" });
      if (since !== undefined) {
        params.set("since", String(since));
      }
      const body = (yield* client.get(
        `/v5/domains/${domain}/records?${params}`,
        scope,
      )) as {
        records?: WireRecord[];
        pagination?: { next?: number | null };
      };
      records.push(...(body.records ?? []));
      const next = body.pagination?.next ?? null;
      if (next === null) {
        break;
      }
      since = next;
    }
    return records;
  });

const findRecord = (
  client: VercelClient,
  domain: string,
  name: string,
  type: string,
  scope: VercelTeamScope,
) =>
  Effect.gen(function* () {
    const records = yield* listRecords(client, domain, scope);
    return records.find(
      (record) =>
        normalizeName(record.name ?? "") === normalizeName(name) &&
        normalizeType(record.type ?? "") === normalizeType(type),
    );
  });

export const RecordProvider = () =>
  Provider.succeed(Record, {
    stables: ["id", "domain", "name", "type"],
    list: Effect.fn(function* () {
      // Records are domain-scoped and Vercel has no cross-domain list
      // endpoint, so global listing is unsupported.
      return [] as RecordAttributes[];
    }),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      if (news.domain !== undefined && news.domain !== output.domain) {
        return { action: "replace" } as const;
      }
      if (
        news.name !== undefined &&
        normalizeName(news.name) !== normalizeName(output.name)
      ) {
        return { action: "replace" } as const;
      }
      if (
        news.type !== undefined &&
        normalizeType(news.type) !== normalizeType(output.type)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const client = yield* Client;
      const current = yield* findRecord(
        client,
        output.domain,
        output.name,
        output.type,
        {},
      ).pipe(
        Effect.catchTag("VercelNotFound", () => Effect.succeed(undefined)),
      );
      if (current === undefined) return undefined;
      const attrs = toAttrs(output.domain, current);
      return attrs.id === output.id ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const client = yield* Client;
      if (news.domain === undefined || news.domain === "") {
        return yield* new RecordDomainMissing({
          name: news.name ?? id,
          type: news.type ?? "",
        });
      }
      const domain = news.domain;
      const scope = {
        teamId: news.teamId,
        teamSlug: news.teamSlug,
      };
      const name =
        news.name !== undefined
          ? normalizeName(news.name)
          : (output?.name ??
            (yield* createPhysicalName({
              id,
              lowercase: true,
              maxLength: 63,
            })));
      const type =
        news.type !== undefined
          ? normalizeType(news.type)
          : (output?.type ?? "");
      if (type === "") {
        return yield* new RecordDomainMissing({ name, type });
      }

      // 1. Observe
      const current = yield* findRecord(client, domain, name, type, scope).pipe(
        Effect.catchTag("VercelNotFound", () => Effect.succeed(undefined)),
      );

      // 2. Ensure
      let observed = current;
      if (observed === undefined) {
        const created = (yield* client.post(
          `/v2/domains/${domain}/records`,
          {
            name,
            type,
            value: news.value,
            ...(news.ttl !== undefined ? { ttl: news.ttl } : {}),
          },
          scope,
        )) as WireRecord;
        const createdId = created.uid ?? created.id;
        observed =
          createdId !== undefined
            ? { ...created, id: createdId }
            : yield* findRecord(client, domain, name, type, scope);
        if (observed === undefined) {
          return yield* new RecordDomainMissing({ name, type });
        }
      } else if (
        (observed.value ?? "") !== news.value ||
        (news.ttl !== undefined && observed.ttl !== news.ttl)
      ) {
        const updated = (yield* client.patch(
          `/v1/domains/records/${observed.uid ?? observed.id}`,
          {
            ...(news.value !== undefined ? { value: news.value } : {}),
            ...(news.ttl !== undefined ? { ttl: news.ttl } : {}),
          },
          scope,
        )) as WireRecord;
        observed = { ...observed, ...updated };
      }

      return toAttrs(domain, observed);
    }),
    delete: Effect.fn(function* ({ output }) {
      const client = yield* Client;
      const current = yield* findRecord(
        client,
        output.domain,
        output.name,
        output.type,
        {},
      ).pipe(
        Effect.catchTag("VercelNotFound", () => Effect.succeed(undefined)),
      );
      if (current === undefined) return;
      const recordId = current.uid ?? current.id;
      if (recordId === undefined) return;
      yield* client
        .del(`/v2/domains/${output.domain}/records/${recordId}`, {})
        .pipe(
          Effect.catchTag("VercelNotFound", () => Effect.succeed(undefined)),
        );

      yield* findRecord(
        client,
        output.domain,
        output.name,
        output.type,
        {},
      ).pipe(
        Effect.flatMap((rrset) =>
          rrset === undefined
            ? Effect.void
            : new RecordStillExists({
                domain: output.domain,
                name: output.name,
                type: output.type,
              }),
        ),
        Effect.retry({
          while: (e) => e._tag === "RecordStillExists",
          times: 8,
          schedule: backoff,
        }),
        Effect.catchTag("RecordStillExists", () => Effect.void),
      );
    }),
  });
