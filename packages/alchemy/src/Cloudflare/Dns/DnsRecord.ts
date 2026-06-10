import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

/**
 * DNS record type literal — every value Cloudflare recognises. Stable
 * across reconciles; changing it triggers a replacement because record
 * type is part of a record's identity.
 */
export type DnsRecordType =
  | "A"
  | "AAAA"
  | "CNAME"
  | "MX"
  | "NS"
  | "OPENPGPKEY"
  | "PTR"
  | "TXT"
  | "CAA"
  | "CERT"
  | "DNSKEY"
  | "DS"
  | "HTTPS"
  | "LOC"
  | "NAPTR"
  | "SMIMEA"
  | "SRV"
  | "SSHFP"
  | "SVCB"
  | "TLSA"
  | "URI"
  | (string & {});

export interface DnsRecordProps {
  /**
   * Zone the record lives in. Stable — changing the zone triggers
   * replacement.
   */
  zoneId: Input<string>;
  /**
   * Fully-qualified record name (e.g. `cluster-admin.microtrack.ai`).
   *
   * Stable — Cloudflare treats `(name, type)` as the record's identity,
   * so a rename is a delete + create. Declared as plain `string` (not
   * `Input<string>`) so it is statically knowable inside `diff`.
   */
  name: string;
  /**
   * Record type. Stable — changing triggers replacement.
   *
   * Declared as plain `string` (narrowed to {@link DnsRecordType}) so
   * `diff` can compare without resolving an `Input`.
   */
  type: DnsRecordType;
  /**
   * Record value. Interpretation depends on `type` — an A record's
   * content is an IPv4, a CNAME's is a target hostname, etc.
   *
   * Mutable — patched in place.
   */
  content: Input<string>;
  /**
   * TTL in seconds (`60`–`86400`), or `"1"` for Cloudflare's "automatic"
   * setting. Must be `"1"` when `proxied` is `true`.
   *
   * @default "1"
   */
  ttl?: number | "1";
  /**
   * Whether to send the record through Cloudflare's proxy (orange-clouded
   * in the dashboard). Only valid for proxiable record types
   * (`A`, `AAAA`, `CNAME`).
   *
   * @default false
   */
  proxied?: boolean;
  /**
   * Free-form comment shown in the dashboard. No effect on DNS responses.
   */
  comment?: string;
  /**
   * Custom tags shown in the dashboard. No effect on DNS responses.
   */
  tags?: ReadonlyArray<string>;
  /**
   * Priority — required for `MX` and `URI` records, ignored for others.
   */
  priority?: number;
  /**
   * Take over an existing record with the same `(zoneId, name, type)`
   * triple instead of failing on conflict. Without this flag, the
   * reconciler refuses to touch a record it didn't create, to protect
   * hand-edited DNS entries.
   *
   * @default false
   */
  adopt?: boolean;
}

export interface DnsRecordAttributes {
  /** Cloudflare-assigned DNS record UUID. */
  recordId: string;
  /** Zone that owns this record. */
  zoneId: string;
  /** Record name (FQDN, as Cloudflare returns it). */
  name: string;
  /** Record type. */
  type: DnsRecordType;
  /** Resolved record value. */
  content: string;
  /** Resolved TTL (Cloudflare echoes `1` for "automatic"). */
  ttl: number;
  /** Whether the record is proxied. */
  proxied: boolean;
  /** ISO8601 creation timestamp. */
  createdOn: string | undefined;
  /** ISO8601 last-modified timestamp. */
  modifiedOn: string | undefined;
}

export type DnsRecord = Resource<
  "Cloudflare.Dns.Record",
  DnsRecordProps,
  DnsRecordAttributes,
  never,
  Providers
>;

/**
 * A single DNS record on a Cloudflare-managed zone.
 *
 * Safety: by default the reconciler refuses to take over a record it
 * didn't create. If `getRecord` by cached id misses, the reconciler
 * scans the zone for an existing `(name, type)` match; finding one
 * without `adopt: true` is a hard error, not a silent overwrite. This
 * protects hand-edited records (especially the apex `A`/`AAAA` and
 * email DKIM/SPF records that the dashboard often manages) from being
 * clobbered.
 *
 * @section Proxied CNAME pointing at a tunnel
 * @example Route a subdomain through a Cloudflare Tunnel
 * ```typescript
 * yield* Cloudflare.DnsRecord("AdminCname", {
 *   zoneId: zone.zoneId,
 *   name: "cluster-admin.example.com",
 *   type: "CNAME",
 *   content: `${tunnel.tunnelId}.cfargotunnel.com`,
 *   proxied: true,
 *   comment: "research admin UI",
 *   adopt: true,
 * });
 * ```
 *
 * @section Plain A record
 * @example Direct A record (not proxied)
 * ```typescript
 * yield* Cloudflare.DnsRecord("ApiA", {
 *   zoneId: zone.zoneId,
 *   name: "api.example.com",
 *   type: "A",
 *   content: "203.0.113.42",
 *   ttl: 300,
 * });
 * ```
 */
export const DnsRecord = Resource<DnsRecord>("Cloudflare.Dns.Record");

// ---------------------------------------------------------------------------
// Observed-state types
// ---------------------------------------------------------------------------

interface ObservedRecord {
  readonly id?: string;
  readonly name?: string;
  readonly type?: DnsRecordType;
  readonly content?: string;
  readonly ttl?: number;
  readonly proxied?: boolean;
  readonly comment?: string;
  readonly tags?: ReadonlyArray<string>;
  readonly priority?: number;
  readonly createdOn?: string;
  readonly modifiedOn?: string;
}

const undef = <T>(v: T | null | undefined): T | undefined =>
  v == null ? undefined : v;

const narrowRecord = (raw: {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  content?: string | null;
  ttl?: number | null;
  proxied?: boolean | null;
  comment?: string | null;
  tags?: ReadonlyArray<string> | null;
  priority?: number | null;
  createdOn?: string | null;
  modifiedOn?: string | null;
}): ObservedRecord => ({
  id: undef(raw.id),
  name: undef(raw.name),
  type: raw.type == null ? undefined : (raw.type as DnsRecordType),
  content: undef(raw.content),
  ttl: undef(raw.ttl),
  proxied: undef(raw.proxied),
  comment: undef(raw.comment),
  tags: raw.tags == null ? undefined : (raw.tags as ReadonlyArray<string>),
  priority: undef(raw.priority),
  createdOn: undef(raw.createdOn),
  modifiedOn: undef(raw.modifiedOn),
});

// ---------------------------------------------------------------------------
// Body construction
// ---------------------------------------------------------------------------

interface RecordMutableBody {
  name: string;
  type: DnsRecordType;
  content: string;
  ttl: number;
  proxied?: boolean;
  comment?: string;
  tags?: ReadonlyArray<string>;
  priority?: number;
}

const buildMutableBody = (
  news: DnsRecordProps,
  resolvedContent: string,
): RecordMutableBody => ({
  name: news.name,
  type: news.type,
  content: resolvedContent,
  // Cloudflare rejects the string `"1"` even though distilled types
  // it as `number | "1"`; the API wants numeric 1 for "automatic".
  ttl:
    news.ttl === undefined
      ? 1
      : news.ttl === ("1" as unknown)
        ? 1
        : (news.ttl as number),
  proxied: news.proxied,
  comment: news.comment,
  tags: news.tags,
  priority: news.priority,
});

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

const arrEq = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
): boolean => {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  const as = [...a].sort();
  const bs = [...b].sort();
  for (let i = 0; i < as.length; i++) if (as[i] !== bs[i]) return false;
  return true;
};

const bodyEqualsObserved = (
  desired: RecordMutableBody,
  observed: ObservedRecord,
): boolean => {
  if (desired.content !== observed.content) return false;
  // CF echoes ttl=1 for "automatic".
  if (desired.ttl !== observed.ttl) return false;
  if (
    desired.proxied !== undefined &&
    desired.proxied !== (observed.proxied ?? false)
  ) {
    return false;
  }
  if (
    desired.comment !== undefined &&
    desired.comment !== (observed.comment ?? "")
  ) {
    return false;
  }
  if (desired.tags !== undefined && !arrEq(desired.tags, observed.tags)) {
    return false;
  }
  if (
    desired.priority !== undefined &&
    desired.priority !== observed.priority
  ) {
    return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const DnsRecordProvider = () =>
  Provider.effect(
    DnsRecord,
    Effect.gen(function* () {
      // Resolve the CF environment for tracing context; per-call zoneId
      // comes from props since DNS records are zone-scoped, not account-
      // scoped.
      yield* CloudflareEnvironment;

      const createRecord = yield* dns.createRecord;
      const getRecord = yield* dns.getRecord;
      const updateRecord = yield* dns.updateRecord;
      const deleteRecord = yield* dns.deleteRecord;
      const listRecords = dns.listRecords;

      const observeById = (zoneId: string, dnsRecordId: string) =>
        Effect.gen(function* () {
          const r = yield* getRecord({ zoneId, dnsRecordId }).pipe(
            // Distilled tags transport errors but a 404 for a missing
            // record surfaces as an untagged error. Swallow so the
            // reconciler falls through to the find-by-name path.
            Effect.catch(() => Effect.succeed(undefined)),
          );
          if (r === undefined) return undefined;
          return narrowRecord(r as Parameters<typeof narrowRecord>[0]);
        });

      // Locate an existing record by `(zoneId, name, type)`. Used both
      // for the adoption path and to surface a conflict when the caller
      // hasn't opted into adoption.
      const findByNameType = (
        zoneId: string,
        name: string,
        type: DnsRecordType,
      ) =>
        listRecords
          .items({
            zoneId,
            name: { exact: name },
            // `type` on the list endpoint is a bare literal, not the
            // `{exact: ...}` struct used for `name`/`content`.
            type: type as dns.ListRecordsRequest["type"],
          })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).find(
                (r) =>
                  (r as { name?: string | null }).name === name &&
                  (r as { type?: string | null }).type === type,
              ),
            ),
            Effect.map((found) =>
              found === undefined
                ? undefined
                : narrowRecord(found as Parameters<typeof narrowRecord>[0]),
            ),
          );

      return {
        stables: ["recordId", "zoneId", "type", "name"],

        diff: Effect.fn(function* ({ olds = {}, news }) {
          const o = olds as DnsRecordProps;
          const n = news as DnsRecordProps;
          if (o.type !== undefined && o.type !== n.type) {
            return { action: "replace" } as const;
          }
          if (o.name !== undefined && o.name !== n.name) {
            return { action: "replace" } as const;
          }
          // zoneId is Input<string>; by reconcile time both sides are
          // concrete strings.
          if (
            typeof o.zoneId === "string" &&
            typeof n.zoneId === "string" &&
            o.zoneId !== n.zoneId
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ news, output }) {
          // Inputs have been resolved to concrete strings by Plan.
          const zoneId = news.zoneId as string;
          const content = news.content as string;
          const body = buildMutableBody(news, content);

          // 1. Observe by cached id first.
          let observed: ObservedRecord | undefined;
          if (output?.recordId) {
            observed = yield* observeById(zoneId, output.recordId);
          }

          // 2. Adoption / collision detection: fall back to scanning the
          //    zone for a (name, type) match.
          let foundByScan = false;
          if (!observed) {
            const existing = yield* findByNameType(
              zoneId,
              news.name,
              news.type,
            );
            if (existing) {
              foundByScan = true;
              if (!news.adopt) {
                return yield* Effect.fail(
                  new Error(
                    `Cloudflare DNS record ${news.type} ${news.name} already exists in zone ${zoneId}. Pass \`adopt: true\` to take ownership of it.`,
                  ),
                );
              }
              observed = existing;
            }
          }

          // 3. Ensure.
          if (!observed) {
            const created = yield* createRecord({
              zoneId,
              name: body.name,
              type: body.type,
              content: body.content,
              ttl: body.ttl,
              proxied: body.proxied,
              comment: body.comment,
              tags: body.tags === undefined ? undefined : Array.from(body.tags),
              priority: body.priority,
            });
            observed = narrowRecord(
              created as Parameters<typeof narrowRecord>[0],
            );
          }

          // 4. Sync — Cloudflare's update endpoint is PUT-style; resend
          //    the full desired body when any mutable field differs.
          if (!observed.id) {
            return yield* Effect.fail(
              new Error("Cloudflare did not return a record id for DNS record"),
            );
          }
          if (!bodyEqualsObserved(body, observed)) {
            // Suppress noise when we just created the record above — the
            // server echo already matches and any diff is a CF-side
            // normalisation we shouldn't fight on the very first reconcile.
            const justCreated = !output?.recordId && !foundByScan;
            if (!justCreated) {
              const updated = yield* updateRecord({
                zoneId,
                dnsRecordId: observed.id,
                name: body.name,
                type: body.type,
                content: body.content,
                ttl: body.ttl,
                proxied: body.proxied,
                comment: body.comment,
                tags:
                  body.tags === undefined ? undefined : Array.from(body.tags),
                priority: body.priority,
              });
              observed = narrowRecord(
                updated as Parameters<typeof narrowRecord>[0],
              );
            }
          }

          // 5. Return.
          if (
            !observed.id ||
            !observed.type ||
            observed.content === undefined ||
            observed.ttl === undefined
          ) {
            return yield* Effect.fail(
              new Error(
                "Cloudflare returned a DNS record without id/type/content/ttl",
              ),
            );
          }
          return {
            recordId: observed.id,
            zoneId,
            name: observed.name ?? body.name,
            type: observed.type,
            content: observed.content,
            ttl: observed.ttl,
            proxied: observed.proxied ?? false,
            createdOn: observed.createdOn,
            modifiedOn: observed.modifiedOn,
          } satisfies DnsRecordAttributes;
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* deleteRecord({
            zoneId: output.zoneId,
            dnsRecordId: output.recordId,
          }).pipe(Effect.catch(() => Effect.void));
        }),

        read: Effect.fn(function* ({ output }) {
          if (!output?.recordId) return undefined;
          const observed = yield* observeById(output.zoneId, output.recordId);
          if (
            !observed?.id ||
            !observed.type ||
            observed.content === undefined ||
            observed.ttl === undefined
          ) {
            return undefined;
          }
          return {
            recordId: observed.id,
            zoneId: output.zoneId,
            name: observed.name ?? output.name,
            type: observed.type,
            content: observed.content,
            ttl: observed.ttl,
            proxied: observed.proxied ?? false,
            createdOn: observed.createdOn ?? output.createdOn,
            modifiedOn: observed.modifiedOn ?? output.modifiedOn,
          } satisfies DnsRecordAttributes;
        }),
      };
    }),
  );

void Option.none;
