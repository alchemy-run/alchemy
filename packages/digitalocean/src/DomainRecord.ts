import * as DO from "@distilled.cloud/digitalocean";
import type { DomainRecord as ApiDomainRecord } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ignoreNotFound, noneIfNotFound } from "./internal/notFound.ts";
import type { Providers } from "./Providers.ts";

export type DomainRecordType = "A" | "AAAA" | "CAA" | "CNAME" | "MX" | "NS" | "SRV" | "TXT";

export type DomainRecordProps = {
  /** The domain the record belongs to. A change replaces the record. */
  domain: string;
  /** Record type. A change replaces the record. */
  type: DomainRecordType;
  /**
   * Host name relative to the domain: `"@"` for the apex, `"www"` for
   * `www.<domain>`. A change updates the record in place.
   */
  name: string;
  /**
   * The record value: an address for A/AAAA, a host name for CNAME, MX and
   * NS (`"@"` for the apex), the text for TXT, the target for SRV, the value
   * for CAA. A change updates the record in place.
   */
  data: string;
  /**
   * Time to live in seconds, at least 30.
   *
   * @default 1800
   */
  ttl?: number;
  /** Priority, for MX and SRV records. */
  priority?: number;
  /** Port, for SRV records. */
  port?: number;
  /** Weight, for SRV records. */
  weight?: number;
  /** Flags, for CAA records (`0` or `128`). */
  flags?: number;
  /** Tag, for CAA records: `"issue"`, `"issuewild"` or `"iodef"`. */
  tag?: string;
};

export type DomainRecord = Resource<
  "DigitalOcean.DomainRecord",
  DomainRecordProps,
  {
    /** Numeric record id. */
    recordId: number;
    /** The domain the record belongs to. */
    domain: string;
    /** Record type. */
    type: string;
    /** Host name relative to the domain. */
    name: string;
    /** The record value. */
    data: string;
    /** Time to live in seconds. */
    ttl: number | undefined;
    /** Priority, for MX and SRV records. */
    priority: number | undefined;
    /** Port, for SRV records. */
    port: number | undefined;
    /** Weight, for SRV records. */
    weight: number | undefined;
    /** Flags, for CAA records. */
    flags: number | undefined;
    /** Tag, for CAA records. */
    tag: string | undefined;
  },
  never,
  Providers
>;

export type DomainRecordAttributes = DomainRecord["Attributes"];

/**
 * A DNS record in a domain hosted on DigitalOcean. `name`, `data`, `ttl` and
 * the type-specific fields update in place; `domain` and `type` replace the
 * record.
 *
 * A record has no tags. Alchemy finds a record it recorded by id, and after
 * a lost deploy by an exact match of name, type and value.
 *
 * ### Address Records
 * **Example:** Point a host name at a droplet
 * ```typescript
 * const domain = yield* DigitalOcean.Domain("example", { name: "example.com" });
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-1vcpu-1gb",
 *   image: "ubuntu-24-04-x64",
 * });
 * yield* DigitalOcean.DomainRecord("www", {
 *   domain: domain.name,
 *   type: "A",
 *   name: "www",
 *   data: host.ipv4,
 *   ttl: 300,
 * });
 * ```
 *
 * ### Mail and Verification Records
 * **Example:** An MX and a TXT record
 * ```typescript
 * const domain = yield* DigitalOcean.Domain("example", { name: "example.com" });
 * yield* DigitalOcean.DomainRecord("mx", {
 *   domain: domain.name,
 *   type: "MX",
 *   name: "@",
 *   data: "mail.example.com.",
 *   priority: 10,
 * });
 * yield* DigitalOcean.DomainRecord("spf", {
 *   domain: domain.name,
 *   type: "TXT",
 *   name: "@",
 *   data: "v=spf1 include:_spf.example.com ~all",
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Domain-Records
 *
 * @resource
 * @product Domains
 * @category Networking
 */
export const DomainRecord = Resource<DomainRecord>("DigitalOcean.DomainRecord");

const PAGE_SIZE = 200;

const toAttrs = (domain: string, record: ApiDomainRecord): DomainRecordAttributes => ({
  recordId: record.id,
  domain,
  type: record.type,
  name: record.name,
  data: record.data,
  ttl: record.ttl ?? undefined,
  priority: record.priority ?? undefined,
  port: record.port ?? undefined,
  weight: record.weight ?? undefined,
  flags: record.flags ?? undefined,
  tag: record.tag ?? undefined,
});

const observeById = (domain: string, recordId: number) =>
  noneIfNotFound(
    DO.getDomainRecord({ domain_name: domain, domain_record_id: recordId }).pipe(
      Effect.map((response) => response.domain_record),
    ),
  );

// The list filters by the fully qualified name.
const fullName = (domain: string, name: string) => (name === "@" ? domain : `${name}.${domain}`);

const observeByContent = (props: DomainRecordProps) =>
  DO.listDomainRecords
    .items({
      domain_name: props.domain,
      name: fullName(props.domain, props.name),
      type: props.type,
      per_page: PAGE_SIZE,
    })
    .pipe(
      Stream.filter((record) => record.data === props.data),
      Stream.runHead,
      // A domain that does not exist yet holds no records.
      Effect.catchTag("NotFound", () => Effect.succeedNone),
    );

const observe = Effect.fn(function* (
  props: DomainRecordProps,
  output: DomainRecordAttributes | undefined,
) {
  if (output !== undefined) {
    const byId = yield* observeById(output.domain, output.recordId);
    if (Option.isSome(byId)) return byId;
  }
  return yield* observeByContent(props);
});

const desiredFields = (news: DomainRecordProps) => ({
  name: news.name,
  data: news.data,
  ttl: news.ttl ?? 1800,
  priority: news.priority ?? null,
  port: news.port ?? null,
  weight: news.weight ?? null,
  flags: news.flags ?? null,
  tag: news.tag ?? null,
});

const isInSync = (record: ApiDomainRecord, news: DomainRecordProps) => {
  const desired = desiredFields(news);
  return (
    record.name === desired.name &&
    record.data === desired.data &&
    record.ttl === desired.ttl &&
    (record.priority ?? null) === desired.priority &&
    (record.port ?? null) === desired.port &&
    (record.weight ?? null) === desired.weight &&
    (record.flags ?? null) === desired.flags &&
    (record.tag ?? null) === desired.tag
  );
};

export const DomainRecordProvider = () =>
  Provider.succeed(DomainRecord, {
    stables: ["recordId", "domain", "type"],
    read: Effect.fn(function* ({ olds, output }) {
      const observed = yield* observe(olds, output);
      return Option.getOrUndefined(Option.map(observed, (r) => toAttrs(olds.domain, r)));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (news.domain !== olds.domain || news.type !== olds.type) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const observed = yield* observe(news, output);
      const record = yield* Option.match(observed, {
        onNone: () =>
          DO.createDomainRecord({
            domain_name: news.domain,
            body: { type: news.type, ...desiredFields(news) },
          }).pipe(Effect.map((response) => response.domain_record)),
        onSome: Effect.succeed,
      });
      if (isInSync(record, news)) return toAttrs(news.domain, record);
      const patched = yield* DO.patchDomainRecord({
        domain_name: news.domain,
        domain_record_id: record.id,
        type: news.type,
        ...desiredFields(news),
      });
      return toAttrs(news.domain, patched.domain_record);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        DO.deleteDomainRecord({ domain_name: output.domain, domain_record_id: output.recordId }),
      );
    }),
  });
