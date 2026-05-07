import * as r2 from "@distilled.cloud/cloudflare/r2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type * as Cloudflare from "../Providers.ts";
import * as Zone from "../Zone.ts";
import { R2BucketBinding } from "./R2BucketBinding.ts";

export type R2BucketName = string;

export type R2BucketCustomDomainZone = Zone.ZoneReference;

export type R2BucketCustomDomain = {
  /**
   * Custom domain name to attach to the bucket.
   */
  name: string;
  /**
   * Zone that contains the custom domain. If omitted, the zone is inferred
   * from `domain`. Pass a zone ID string, a hostname in the zone, or any object
   * with a `zoneId` attribute such as `Cloudflare.Zone`.
   */
  zone?: R2BucketCustomDomainZone;
  /**
   * Whether public bucket access is enabled at this custom domain.
   * @default true
   */
  enabled?: boolean;
  /**
   * Allowlist of TLS ciphers in BoringSSL format.
   */
  ciphers?: string[];
  /**
   * Minimum TLS version accepted by the custom domain.
   * @default "1.0"
   */
  minTLS?: "1.0" | "1.1" | "1.2" | "1.3";
};

export type R2BucketProps = {
  /**
   * Name of the bucket. If omitted, a unique name will be generated.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Storage class for newly uploaded objects.
   * @default "Standard"
   */
  storageClass?: R2Bucket.StorageClass;
  /**
   * Jurisdiction where objects in this bucket are guaranteed to be stored.
   * @default "default"
   */
  jurisdiction?: R2Bucket.Jurisdiction;
  /**
   * Location hint for the bucket.
   */
  locationHint?: R2Bucket.Location;
  /**
   * Custom domains to attach to the bucket. Pass an empty array (or omit)
   * to remove all custom domains.
   */
  domains?: R2BucketCustomDomain[];
};

export type R2Bucket = Resource<
  "Cloudflare.R2Bucket",
  R2BucketProps,
  {
    bucketName: R2BucketName;
    storageClass: R2Bucket.StorageClass;
    jurisdiction: R2Bucket.Jurisdiction;
    location: R2Bucket.Location | undefined;
    accountId: string;
    domains: R2Bucket.CustomDomain[];
  },
  never,
  Cloudflare.Providers
>;

/**
 * A Cloudflare R2 object storage bucket with S3-compatible API.
 *
 * R2 provides zero-egress-fee object storage. Create a bucket as a resource,
 * then bind it to a Worker to read and write objects at runtime.
 *
 * @section Creating a Bucket
 * @example Basic R2 bucket
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("MyBucket");
 * ```
 *
 * @example Bucket with location hint
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("MyBucket", {
 *   locationHint: "wnam",
 * });
 * ```
 *
 * @section Binding to a Worker
 * @example Reading and writing objects
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket.bind(MyBucket);
 *
 * // Write an object
 * yield* bucket.put("hello.txt", "Hello, World!");
 *
 * // Read an object
 * const object = yield* bucket.get("hello.txt");
 * if (object) {
 *   const text = yield* object.text();
 * }
 * ```
 *
 * @example Streaming upload with content length
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket.bind(MyBucket);
 *
 * yield* bucket.put("upload.bin", request.stream, {
 *   contentLength: Number(request.headers["content-length"] ?? 0),
 * });
 * ```
 *
 * @section Custom Domains
 *
 * Attach one or more custom domains to serve bucket objects from a hostname
 * you control. The domain's zone must already exist in your Cloudflare
 * account; the zone is inferred from the hostname when omitted, or you can
 * pass a `Cloudflare.Zone` resource, a zone ID, or any hostname inside the
 * zone via the `zone` field.
 *
 * @example Single custom domain
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("MyBucket", {
 *   domains: [{ name: "assets.example.com" }],
 * });
 * ```
 *
 * @example Multiple custom domains
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("MyBucket", {
 *   domains: [
 *     { name: "assets.example.com" },
 *     { name: "static.example.com" },
 *   ],
 * });
 * ```
 *
 * @example Disable a custom domain without removing it
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("MyBucket", {
 *   domains: [{ name: "assets.example.com", enabled: false }],
 * });
 * ```
 *
 * @example Custom domain with explicit zone and TLS settings
 * ```typescript
 * const zone = yield* Cloudflare.Zone("ExampleZone", {
 *   name: "example.com",
 * });
 *
 * const bucket = yield* Cloudflare.R2Bucket("MyBucket", {
 *   domains: [
 *     {
 *       name: "assets.example.com",
 *       zone,
 *       minTLS: "1.2",
 *     },
 *   ],
 * });
 * ```
 */
export const R2Bucket = Resource<R2Bucket>("Cloudflare.R2Bucket")({
  bind: R2BucketBinding.bind,
});

export declare namespace R2Bucket {
  export type StorageClass = "Standard" | "InfrequentAccess";
  export type Jurisdiction = "default" | "eu" | "fedramp";
  export type Location = "apac" | "eeur" | "enam" | "weur" | "wnam" | "oc";
  export type CustomDomain = {
    domain: string;
    zoneId: string | undefined;
    enabled: boolean;
    ciphers: string[] | undefined;
    minTLS: "1.0" | "1.1" | "1.2" | "1.3" | undefined;
    status:
      | {
          ownership:
            | "pending"
            | "active"
            | "deactivated"
            | "blocked"
            | "error"
            | "unknown";
          ssl:
            | "initializing"
            | "pending"
            | "active"
            | "deactivated"
            | "error"
            | "unknown";
        }
      | undefined;
  };
}

export const R2BucketProvider = () =>
  Provider.effect(
    R2Bucket,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const createBucket = yield* r2.createBucket;
      const patchBucket = yield* r2.patchBucket;
      const deleteBucket = yield* r2.deleteBucket;
      const getBucket = yield* r2.getBucket;
      const listBucketDomainCustoms = yield* r2.listBucketDomainCustoms;
      const createBucketDomainCustom = yield* r2.createBucketDomainCustom;
      const updateBucketDomainCustom = yield* r2.updateBucketDomainCustom;
      const deleteBucketDomainCustom = yield* r2.deleteBucketDomainCustom;

      const createBucketName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          if (name) return name;
          return (yield* createPhysicalName({
            id,
            maxLength: 63,
          })).toLowerCase();
        });

      const normalizeLocation = (
        location: string | undefined | null,
      ): R2Bucket.Location | undefined => {
        if (!location) return undefined;
        return location.toLowerCase() as R2Bucket.Location;
      };

      const listCustomDomains = (
        bucketName: string,
        jurisdiction: R2Bucket.Jurisdiction,
      ) =>
        listBucketDomainCustoms({
          accountId,
          bucketName,
          jurisdiction,
        }).pipe(
          Effect.retry({
            while: isNoSuchBucket,
            schedule: r2CustomDomainConsistencySchedule,
          }),
          Effect.map((response) =>
            response.domains.map(toCustomDomainAttributes),
          ),
          Effect.catchTag("NoSuchBucket", () => Effect.succeed(undefined)),
        );

      const reconcileCustomDomains = (
        bucketName: string,
        jurisdiction: R2Bucket.Jurisdiction,
        desired: R2BucketCustomDomain[],
        previous: R2Bucket.CustomDomain[],
      ) =>
        Effect.gen(function* () {
          const observed = yield* listCustomDomains(bucketName, jurisdiction);
          if (!observed) {
            return yield* Effect.fail(
              new Error(
                `Cannot reconcile custom domains for missing R2 bucket "${bucketName}"`,
              ),
            );
          }
          const observedByDomain = new Map(
            observed.map((domain) => [domain.domain, domain]),
          );
          const desiredDomains = new Set(desired.map((domain) => domain.name));

          // Remove domains that are no longer desired. Domains that keep the
          // same hostname but move zones are intentionally skipped here and
          // handled in the per-domain flow below.
          yield* Effect.forEach(
            previous,
            (previousDomain) =>
              desiredDomains.has(previousDomain.domain)
                ? Effect.void
                : deleteBucketDomainCustom({
                    accountId,
                    bucketName,
                    domain: previousDomain.domain,
                    jurisdiction,
                  }).pipe(
                    Effect.catchIf(
                      isMissingCustomDomainOrBucket,
                      () => Effect.void,
                    ),
                  ),
            { concurrency: "unbounded" },
          );

          const applied = yield* Effect.forEach(
            desired,
            (domain) =>
              Effect.gen(function* () {
                const zoneId = yield* Zone.resolveZoneId({
                  accountId,
                  zone: domain.zone,
                  hostname: domain.name,
                });
                const observedDomain = observedByDomain.get(domain.name);

                if (
                  observedDomain &&
                  sameCustomDomainConfig(observedDomain, domain, zoneId)
                ) {
                  return observedDomain;
                }

                if (observedDomain && observedDomain.zoneId !== zoneId) {
                  // Cloudflare does not mutate the zone for an existing custom
                  // domain. This is not a duplicate of the stale-domain prune
                  // above: the hostname is still desired, so that prune skips it
                  // and this branch deletes only to recreate it in the new zone.
                  yield* deleteBucketDomainCustom({
                    accountId,
                    bucketName,
                    domain: domain.name,
                    jurisdiction,
                  }).pipe(
                    Effect.catchIf(
                      isMissingCustomDomainOrBucket,
                      () => Effect.void,
                    ),
                  );
                }

                if (!observedDomain || observedDomain.zoneId !== zoneId) {
                  const created = yield* createBucketDomainCustom({
                    accountId,
                    bucketName,
                    jurisdiction,
                    domain: domain.name,
                    enabled: domain.enabled ?? true,
                    zoneId,
                    ciphers: domain.ciphers,
                    minTLS: domain.minTLS,
                  }).pipe(
                    Effect.retry({
                      while: isNoSuchBucket,
                      schedule: r2CustomDomainConsistencySchedule,
                    }),
                  );
                  return toCustomDomainAttributes({ ...created, zoneId });
                }

                const updated = yield* updateBucketDomainCustom({
                  accountId,
                  bucketName,
                  domain: domain.name,
                  jurisdiction,
                  enabled: domain.enabled ?? true,
                  ciphers: domain.ciphers,
                  minTLS: domain.minTLS,
                }).pipe(
                  Effect.retry({
                    while: isNoSuchBucket,
                    schedule: r2CustomDomainConsistencySchedule,
                  }),
                );
                return toCustomDomainAttributes({
                  ...updated,
                  enabled: updated.enabled ?? domain.enabled ?? true,
                  zoneId,
                });
              }),
            { concurrency: "unbounded" },
          );

          return applied.sort((a, b) => a.domain.localeCompare(b.domain));
        });

      return {
        stables: ["bucketName", "accountId"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
          if (!isResolved(news)) return undefined;
          const name = yield* createBucketName(id, news.name);
          const oldName = output?.bucketName
            ? output.bucketName
            : yield* createBucketName(id, olds.name);
          const oldJurisdiction =
            output?.jurisdiction ?? olds.jurisdiction ?? "default";
          const oldStorageClass =
            output?.storageClass ?? olds.storageClass ?? "Standard";
          if (
            (output?.accountId ?? accountId) !== accountId ||
            oldName !== name ||
            oldJurisdiction !== (news.jurisdiction ?? "default") ||
            olds.locationHint !== news.locationHint
          ) {
            return { action: "replace" } as const;
          }
          if (oldStorageClass !== (news.storageClass ?? "Standard")) {
            return {
              action: "update",
              stables: oldName === name ? ["bucketName"] : undefined,
            } as const;
          }
          if (!deepEqual(olds.domains, news.domains)) {
            return { action: "update" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output }) {
          const name = yield* createBucketName(id, news.name);
          const acct = output?.accountId ?? accountId;
          const jurisdiction =
            output?.jurisdiction ?? news.jurisdiction ?? "default";

          // Observe — fetch the bucket. R2 reports a deleted bucket as
          // `NoSuchBucket`; tolerate that so the reconciler falls
          // through to the create path.
          let observed = yield* getBucket({
            accountId: acct,
            bucketName: name,
            jurisdiction,
          }).pipe(
            Effect.catchTag("NoSuchBucket", () => Effect.succeed(undefined)),
          );

          // Ensure — create if missing. R2 reports a concurrent create
          // (or partial state-persistence failure) as
          // `BucketAlreadyExists`; tolerate by re-fetching the bucket.
          if (!observed) {
            observed = yield* createBucket({
              accountId: acct,
              name,
              storageClass: news.storageClass,
              jurisdiction: news.jurisdiction,
              locationHint: news.locationHint,
            }).pipe(
              Effect.catchTag("BucketAlreadyExists", () =>
                getBucket({
                  accountId: acct,
                  bucketName: name,
                  jurisdiction: news.jurisdiction,
                }),
              ),
            );
          }

          // Sync — storage class is the only mutable property; location
          // and jurisdiction are immutable (the diff function flags those
          // as `replace`). Only patch when the desired class drifts from
          // observed to avoid unnecessary API calls.
          const desiredStorageClass = news.storageClass ?? "Standard";
          const observedStorageClass = observed.storageClass ?? "Standard";
          if (observedStorageClass !== desiredStorageClass) {
            observed = yield* patchBucket({
              accountId: acct,
              bucketName: observed.name!,
              storageClass: desiredStorageClass,
              jurisdiction: observed.jurisdiction ?? jurisdiction,
            });
          }

          const attrs = {
            bucketName: observed.name!,
            storageClass: observed.storageClass ?? "Standard",
            jurisdiction: observed.jurisdiction ?? "default",
            location: normalizeLocation(observed.location),
            accountId: acct,
          };

          const domains = yield* reconcileCustomDomains(
            attrs.bucketName,
            attrs.jurisdiction,
            news.domains ?? [],
            output?.domains ?? [],
          );

          return {
            ...attrs,
            domains,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          for (const domain of output.domains ?? []) {
            yield* deleteBucketDomainCustom({
              accountId: output.accountId,
              bucketName: output.bucketName,
              domain: domain.domain,
              jurisdiction: output.jurisdiction,
            }).pipe(
              Effect.catchIf(isMissingCustomDomainOrBucket, () => Effect.void),
            );
          }
          yield* deleteBucket({
            accountId: output.accountId,
            bucketName: output.bucketName,
            jurisdiction: output.jurisdiction,
          }).pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const name =
            output?.bucketName ?? (yield* createBucketName(id, olds?.name));
          const acct = output?.accountId ?? accountId;
          return yield* getBucket({
            accountId: acct,
            bucketName: name,
            jurisdiction: output?.jurisdiction ?? olds?.jurisdiction,
          }).pipe(
            Effect.map((bucket) => ({
              bucketName: bucket.name!,
              storageClass: bucket.storageClass ?? "Standard",
              jurisdiction: bucket.jurisdiction ?? "default",
              location: normalizeLocation(bucket.location),
              accountId: acct,
              domains: output?.domains ?? [],
            })),
            Effect.catchTag("NoSuchBucket", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );

// R2 can make a newly-created bucket visible to `getBucket` before the custom
// domain endpoints accept it. Retry only that narrow `NoSuchBucket` lag here;
// not-found domains are still treated as terminal for idempotent deletes.
const r2CustomDomainConsistencySchedule = Schedule.exponential(100).pipe(
  Schedule.both(Schedule.recurs(5)),
);

type CustomDomainResponse = {
  domain: string;
  zoneId?: string | null;
  enabled?: boolean | null;
  ciphers?: string[] | null;
  minTLS?: "1.0" | "1.1" | "1.2" | "1.3" | null;
  status?: R2Bucket.CustomDomain["status"];
};

const toCustomDomainAttributes = (
  domain: CustomDomainResponse,
): R2Bucket.CustomDomain => ({
  domain: domain.domain,
  zoneId: domain.zoneId ?? undefined,
  enabled: domain.enabled ?? true,
  ciphers: domain.ciphers ?? undefined,
  minTLS: domain.minTLS ?? undefined,
  status: domain.status,
});

const sameCustomDomainConfig = (
  observed: R2Bucket.CustomDomain | undefined,
  desired: R2BucketCustomDomain,
  zoneId: string,
): boolean =>
  observed !== undefined &&
  observed.zoneId === zoneId &&
  observed.enabled === (desired.enabled ?? true) &&
  deepEqual(observed.ciphers, desired.ciphers) &&
  observed.minTLS === desired.minTLS;

const isMissingCustomDomainOrBucket = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (("status" in error && (error as { status: unknown }).status === 404) ||
    ("_tag" in error &&
      ((error as { _tag: unknown })._tag === "DomainNotFound" ||
        (error as { _tag: unknown })._tag === "NoSuchBucket")));

const isNoSuchBucket = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error as { _tag: unknown })._tag === "NoSuchBucket";
