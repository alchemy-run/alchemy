import * as dns from "@distilled.cloud/vercel/dns";
import * as domains from "@distilled.cloud/vercel/domains";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";
import type { Domain } from "./Domain.ts";
import type { Providers } from "../Providers.ts";

/** The DNS zone the record lives in — a `Vercel.Domain` or a plain name. */
export type DnsRecordDomainSource = Domain | { name: string } | string;

export type DnsRecordType =
  | "A"
  | "AAAA"
  | "ALIAS"
  | "CAA"
  | "CNAME"
  | "HTTPS"
  | "MX"
  | "SRV"
  | "TXT"
  | "NS";

export interface DnsRecordSrv {
  /** The SRV target hostname. */
  target: string;
  /** The SRV weight (0-65535). */
  weight: number;
  /** The SRV port (0-65535). */
  port: number;
  /** The SRV priority (0-65535). */
  priority: number;
}

export interface DnsRecordHttps {
  /** The HTTPS priority (0-65535). */
  priority: number;
  /** The HTTPS target hostname. */
  target: string;
  /** The HTTPS parameter string, e.g. `alpn=h2,h3`. */
  params?: string;
}

export interface DnsRecordProps {
  /**
   * The domain (DNS zone) to create the record in. Accepts a
   * `Vercel.Domain` resource or a plain domain name. The domain must have a
   * Vercel DNS zone (`zone: true` on the `Domain`). Changing the domain
   * replaces the record.
   */
  domain: DnsRecordDomainSource;
  /**
   * The DNS record type.
   */
  type: DnsRecordType;
  /**
   * A subdomain name, or an empty string for the root domain. Required for
   * every record type except SRV and HTTPS (whose name derives from
   * `srv`/`https`).
   */
  name?: string;
  /**
   * The record value (address, hostname, or text depending on the type).
   * Not used for SRV and HTTPS records.
   */
  value?: string;
  /**
   * Time-to-live in seconds (60 – 2147483647).
   * @default 60
   */
  ttl?: number;
  /**
   * The MX priority (0-65535). Required for MX records.
   */
  mxPriority?: number;
  /**
   * The SRV payload. Required for SRV records.
   */
  srv?: DnsRecordSrv;
  /**
   * The HTTPS payload. Required for HTTPS records.
   */
  https?: DnsRecordHttps;
  /**
   * A comment to add context on what this DNS record is for (max 500
   * characters).
   */
  comment?: string;
}

export type DnsRecord = Resource<
  "Vercel.DnsRecord",
  DnsRecordProps,
  {
    /**
     * The record's unique id. NOTE: Vercel mints a NEW id on every update —
     * the id is not stable across updates.
     */
    recordId: string;
    /** The domain (zone) the record lives in. */
    domain: string;
    /** The DNS record type. */
    type: string;
    /** The record name (subdomain, or empty string for the root). */
    name: string;
    /**
     * The record value as stored by Vercel (derived server-side for
     * MX/SRV/HTTPS records).
     */
    value: string;
    /** Time-to-live in seconds. */
    ttl: number | undefined;
    /** The MX priority, when set. */
    mxPriority: number | undefined;
    /** The SRV payload, when set. */
    srv: DnsRecordSrv | undefined;
    /** The HTTPS payload, when set. */
    https: DnsRecordHttps | undefined;
    /** The record comment, when set. */
    comment: string | undefined;
  },
  never,
  Providers
>;

type DnsRecordAttributes = DnsRecord["Attributes"];

/**
 * A DNS record in a Vercel-hosted DNS zone.
 *
 * The parent domain must be a Vercel DNS zone — add it with
 * `Vercel.Domain` (which enables `zone` by default). Records in a zone that
 * is not Vercel-hosted are rejected by the API with `invalid_zone`.
 *
 * @resource
 * @section Creating records
 * @example TXT record
 * ```typescript
 * const zone = yield* Vercel.Domain("Zone", { name: "acme.com" });
 * yield* Vercel.DnsRecord("Verification", {
 *   domain: zone,
 *   type: "TXT",
 *   name: "_verify",
 *   value: "token-123",
 * });
 * ```
 *
 * @example CNAME record
 * ```typescript
 * yield* Vercel.DnsRecord("Www", {
 *   domain: zone,
 *   type: "CNAME",
 *   name: "www",
 *   value: "cname.vercel-dns.com",
 * });
 * ```
 *
 * @example MX record
 * ```typescript
 * yield* Vercel.DnsRecord("Mail", {
 *   domain: zone,
 *   type: "MX",
 *   name: "",
 *   value: "mail.acme.com",
 *   mxPriority: 10,
 * });
 * ```
 *
 * @see https://vercel.com/docs/domains/managing-dns-records
 */
export const DnsRecord = Resource<DnsRecord>("Vercel.DnsRecord");

const resolveDomainName = (
  source: DnsRecordDomainSource | undefined,
): string | undefined => {
  if (source === undefined) return undefined;
  if (typeof source === "string") return source;
  if ("name" in source && typeof source.name === "string") return source.name;
  return undefined;
};

/** Read a record by id, returning `undefined` when it no longer exists. */
const observeRecord = (recordId: string) =>
  dns
    .getDomainsRecordsByRecordId({ recordId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toAttributes = (
  observed: dns.GetDomainsRecordsByRecordIdResponse,
  props: Partial<Pick<DnsRecordProps, "mxPriority" | "srv" | "https">>,
): DnsRecordAttributes => ({
  recordId: observed.id,
  domain: observed.domain,
  type: observed.recordType,
  name: observed.name,
  value: observed.value,
  ttl: observed.ttl,
  mxPriority: props.mxPriority,
  srv: props.srv,
  https: props.https,
  comment: observed.comment,
});

export const DnsRecordProvider = () =>
  Provider.succeed(DnsRecord, {
    diff: Effect.fn(function* ({ olds, news, output }) {
      // Detect an upstream domain change before short-circuiting on
      // unresolved news — a replaced parent domain must replace the record.
      const oldDomain =
        output?.domain ??
        resolveDomainName(olds.domain as DnsRecordDomainSource);
      const newDomain =
        "domain" in news
          ? resolveDomainName(news.domain as DnsRecordDomainSource)
          : undefined;
      if (oldDomain !== undefined && oldDomain !== newDomain) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      if (!output?.recordId) return undefined;
      const observed = yield* observeRecord(output.recordId);
      if (observed === undefined) return undefined;
      return toAttributes(observed, olds ?? {});
    }),
    list: Effect.fn(function* () {
      const { teamId } = yield* VercelEnvironment.current;
      // Records are scoped to a domain with no account-wide enumeration —
      // fan out over every domain on the team.
      const domainNames: string[] = [];
      let domainsUntil: number | undefined;
      do {
        const page = yield* domains.getDomains({
          teamId,
          limit: 100,
          until: domainsUntil,
        });
        domainNames.push(...page.domains.map((d) => d.name));
        domainsUntil = page.pagination.next ?? undefined;
      } while (domainsUntil !== undefined);

      const perDomain = yield* Effect.forEach(
        domainNames,
        (domain) =>
          Effect.gen(function* () {
            const rows: DnsRecordAttributes[] = [];
            let until: number | undefined;
            do {
              const body = yield* dns.getRecords({
                domain,
                teamId,
                limit: "100",
                ...(until !== undefined ? { until: String(until) } : {}),
              });
              if (typeof body === "string") break;
              for (const record of body.records) {
                // Zone-management records Vercel creates itself (CAA etc.)
                // belong to the zone, not to any alchemy resource.
                if (record.creator === "system") continue;
                rows.push({
                  recordId: record.id,
                  domain,
                  type: record.type,
                  name: record.name,
                  value: record.value,
                  ttl: record.ttl,
                  mxPriority: record.mxPriority,
                  srv: undefined,
                  https: undefined,
                  comment: record.comment,
                });
              }
              until =
                "pagination" in body
                  ? (body.pagination.next ?? undefined)
                  : undefined;
            } while (until !== undefined);
            return rows;
          }).pipe(
            // The domain may be deleted between enumeration and listing.
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          ),
        { concurrency: 8 },
      );
      return perDomain.flat();
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const { teamId } = yield* VercelEnvironment.current;
      const domain = resolveDomainName(news.domain);
      if (domain === undefined) {
        return yield* Effect.die(
          "Invalid Vercel DNS record domain source: must be a Domain, { name } or a plain domain name",
        );
      }

      // Observe — the record id from prior output is a cache, not a
      // guarantee: the record may have been deleted out-of-band, and Vercel
      // mints a new id on every update.
      const observed = output?.recordId
        ? yield* observeRecord(output.recordId)
        : undefined;

      if (observed === undefined) {
        // Ensure — create. Vercel upserts an identical (name, type, value)
        // record, returning the existing id, so a crash-retry converges.
        const created = yield* dns.createRecord({
          domain,
          teamId,
          type: news.type,
          ...(news.name !== undefined ? { name: news.name } : {}),
          ...(news.value !== undefined ? { value: news.value } : {}),
          ...(news.ttl !== undefined ? { ttl: news.ttl } : {}),
          ...(news.mxPriority !== undefined
            ? { mxPriority: news.mxPriority }
            : {}),
          ...(news.srv !== undefined ? { srv: news.srv } : {}),
          ...(news.https !== undefined ? { https: news.https } : {}),
          ...(news.comment !== undefined ? { comment: news.comment } : {}),
        });
        const fresh = yield* observeRecord(created.uid);
        if (fresh === undefined) {
          return yield* Effect.die(
            `Vercel DNS record ${created.uid} not observable after create`,
          );
        }
        return toAttributes(fresh, news);
      }

      // Sync — diff OBSERVED cloud state against desired; PATCH only the
      // delta. The read API does not return mxPriority/srv/https, so those
      // are compared against the prior output snapshot (the only baseline
      // that exists for them).
      const scalarDelta =
        observed.recordType !== news.type ||
        (news.name !== undefined && observed.name !== news.name) ||
        (news.value !== undefined && observed.value !== news.value) ||
        (observed.ttl ?? 60) !== (news.ttl ?? 60) ||
        (news.comment !== undefined && observed.comment !== news.comment);
      const blindDelta =
        JSON.stringify({
          mxPriority: news.mxPriority,
          srv: news.srv,
          https: news.https,
        }) !==
        JSON.stringify({
          mxPriority: output?.mxPriority,
          srv: output?.srv,
          https: output?.https,
        });

      if (!scalarDelta && !blindDelta) {
        return toAttributes(observed, news);
      }

      // NOTE: updateRecord mints a NEW record id — persist the returned id.
      const updated = yield* dns.updateRecord({
        recordId: observed.id,
        teamId,
        type: news.type,
        ...(news.name !== undefined ? { name: news.name } : {}),
        ...(news.value !== undefined ? { value: news.value } : {}),
        ...(news.ttl !== undefined ? { ttl: news.ttl } : {}),
        ...(news.mxPriority !== undefined
          ? { mxPriority: news.mxPriority }
          : {}),
        ...(news.srv !== undefined ? { srv: news.srv } : {}),
        ...(news.https !== undefined ? { https: news.https } : {}),
        ...(news.comment !== undefined ? { comment: news.comment } : {}),
      });
      return {
        recordId: updated.id,
        domain: updated.domain,
        type: updated.recordType,
        name: updated.name,
        value: updated.value,
        ttl: updated.ttl,
        mxPriority: news.mxPriority,
        srv: news.srv,
        https: news.https,
        comment: updated.comment,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      const { teamId } = yield* VercelEnvironment.current;
      yield* dns
        .removeRecord({
          domain: output.domain,
          recordId: output.recordId,
          teamId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
