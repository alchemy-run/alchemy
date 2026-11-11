import { endpointFor } from "@distilled.cloud/digitalocean/Spaces";
import * as S3 from "@distilled.cloud/s3";
import { Endpoint } from "@distilled.cloud/s3/Endpoint";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { Providers } from "../Providers.ts";
import type { RegionSlug } from "../Slugs.ts";

export type BucketAcl = "private" | "public-read";

export type BucketCorsRule = {
  /** Origins allowed to make cross-origin requests, for example `"https://example.com"` or `"*"`. */
  allowedOrigins: string[];
  /** Methods allowed, for example `["GET", "PUT"]`. */
  allowedMethods: Array<"GET" | "PUT" | "POST" | "DELETE" | "HEAD">;
  /** Request headers allowed. */
  allowedHeaders?: string[];
  /** Seconds a browser caches the preflight response. */
  maxAgeSeconds?: number;
};

export type BucketLifecycleRule = {
  /** Rule id. */
  id: string;
  /** Apply only to keys with this prefix. @default every key */
  prefix?: string;
  /** Delete objects this many days after they were created. */
  expirationDays?: number;
  /** Abort multipart uploads that are not finished after this many days. */
  abortIncompleteMultipartUploadDays?: number;
};

export type BucketProps = {
  /**
   * Bucket name, unique across every Spaces region: 3 to 63 lowercase
   * letters, digits and `-`. A change replaces the bucket.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Region slug, for example `"nyc3"`, `"sfo3"`, `"ams3"`. A change replaces the bucket. */
  region: RegionSlug;
  /**
   * `"public-read"` lets anyone list and read objects. Objects can also be
   * made public one by one.
   *
   * @default "private"
   */
  acl?: BucketAcl;
  /**
   * Keep every version of every object.
   *
   * @default false
   */
  versioning?: boolean;
  /** Cross-origin rules for browsers. */
  cors?: BucketCorsRule[];
  /** Expiration rules. */
  lifecycleRules?: BucketLifecycleRule[];
  /**
   * Delete every object (and version) when the bucket is destroyed.
   * Otherwise destroying a bucket that holds objects fails.
   *
   * @default false
   */
  forceDestroy?: boolean;
};

export type Bucket = Resource<
  "DigitalOcean.Spaces.Bucket",
  BucketProps,
  {
    /** Bucket name. */
    bucketName: string;
    /** Region slug. */
    region: string;
    /** S3 endpoint of the region, for S3 clients: `https://<region>.digitaloceanspaces.com`. */
    endpoint: string;
    /** Host name of the bucket, `<bucket>.<region>.digitaloceanspaces.com`; the origin of a CDN endpoint. */
    domainName: string;
    /** HTTPS URL of the bucket. */
    url: string;
  },
  never,
  Providers
>;

export type BucketAttributes = Bucket["Attributes"];

/**
 * A DigitalOcean Spaces bucket: S3-compatible object storage in one
 * region. `acl`, `versioning`, `cors`, `lifecycleRules` and
 * `forceDestroy` update in place; `name` and `region` replace the bucket.
 *
 * Spaces speaks the S3 API, which signs with Spaces access keys rather than
 * the DigitalOcean token. Alchemy uses the Spaces keys in your profile when
 * it has them, and otherwise creates a full-access key for the deploy and
 * deletes it afterwards.
 *
 * Spaces buckets have no tags. Alchemy owns a bucket whose name it
 * generated or that it recorded; a bucket that already has the chosen name
 * on the team is `Unowned` and needs `--adopt`.
 *
 * ### Creating a Bucket
 * **Example:** A private bucket
 * ```typescript
 * const assets = yield* DigitalOcean.Spaces.Bucket("assets", { region: "nyc3" });
 * ```
 *
 * **Example:** A public bucket for static files, with CORS
 * ```typescript
 * const site = yield* DigitalOcean.Spaces.Bucket("site", {
 *   region: "nyc3",
 *   acl: "public-read",
 *   cors: [{ allowedOrigins: ["*"], allowedMethods: ["GET", "HEAD"] }],
 * });
 * ```
 *
 * ### Keeping Versions and Expiring Objects
 * **Example:** Versioned uploads that expire after 30 days
 * ```typescript
 * const uploads = yield* DigitalOcean.Spaces.Bucket("uploads", {
 *   region: "sfo3",
 *   versioning: true,
 *   lifecycleRules: [
 *     { id: "expire-tmp", prefix: "tmp/", expirationDays: 30 },
 *     { id: "abort-multipart", abortIncompleteMultipartUploadDays: 7 },
 *   ],
 * });
 * ```
 *
 * ### Serving Through the CDN
 * **Example:** A CDN endpoint in front of a bucket
 * ```typescript
 * const site = yield* DigitalOcean.Spaces.Bucket("site", { region: "nyc3", acl: "public-read" });
 * const cdn = yield* DigitalOcean.Spaces.CdnEndpoint("site-cdn", { origin: site.domainName });
 * // Serve from https://${cdn.endpoint}
 * ```
 *
 * @see https://docs.digitalocean.com/products/spaces/reference/s3-compatibility/
 *
 * @resource
 * @product Spaces
 * @category Storage
 */
export const Bucket = Resource<Bucket>("DigitalOcean.Spaces.Bucket");

const NAME_MAX_LENGTH = 63;

const toAttrs = (bucketName: string, region: string): BucketAttributes => ({
  bucketName,
  region,
  endpoint: endpointFor(region),
  domainName: `${bucketName}.${region}.digitaloceanspaces.com`,
  url: `https://${bucketName}.${region}.digitaloceanspaces.com`,
});

const physicalName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: NAME_MAX_LENGTH });

/** Sends S3 calls to a Spaces region. */
export const inRegion =
  (region: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(Endpoint, Effect.succeed(endpointFor(region))));

const exists = (bucket: string, region: string) =>
  S3.headBucket({ Bucket: bucket }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
    inRegion(region),
  );

// A new bucket answers NoSuchBucket on its sub-resources for a few seconds.
const whileNoSuchBucket = {
  while: (error: { readonly _tag: string }) => error._tag === "NoSuchBucket",
  schedule: Schedule.spaced("2 seconds"),
  times: 15,
} as const;

const syncAcl = (bucket: string, acl: BucketAcl) => S3.putBucketAcl({ Bucket: bucket, ACL: acl });

const syncVersioning = Effect.fn(function* (bucket: string, enabled: boolean) {
  const current = yield* S3.getBucketVersioning({ Bucket: bucket });
  const status = current.Status;
  // A bucket that never had versioning reports no status; leave it alone.
  if (!enabled && status === undefined) return;
  const desired = enabled ? "Enabled" : "Suspended";
  if (status === desired) return;
  yield* S3.putBucketVersioning({
    Bucket: bucket,
    VersioningConfiguration: { Status: desired },
  });
});

const syncCors = Effect.fn(function* (bucket: string, cors: ReadonlyArray<BucketCorsRule>) {
  if (cors.length === 0) {
    yield* S3.deleteBucketCors({ Bucket: bucket });
    return;
  }
  yield* S3.putBucketCors({
    Bucket: bucket,
    CORSConfiguration: {
      CORSRules: cors.map((rule) => ({
        AllowedOrigins: rule.allowedOrigins,
        AllowedMethods: rule.allowedMethods,
        AllowedHeaders: rule.allowedHeaders,
        MaxAgeSeconds: rule.maxAgeSeconds,
      })),
    },
  });
});

const syncLifecycle = Effect.fn(function* (
  bucket: string,
  rules: ReadonlyArray<BucketLifecycleRule>,
) {
  if (rules.length === 0) {
    yield* S3.deleteBucketLifecycle({ Bucket: bucket });
    return;
  }
  yield* S3.putBucketLifecycleConfiguration({
    Bucket: bucket,
    LifecycleConfiguration: {
      Rules: rules.map((rule) => ({
        ID: rule.id,
        Status: "Enabled",
        Prefix: rule.prefix ?? "",
        Expiration: rule.expirationDays === undefined ? undefined : { Days: rule.expirationDays },
        AbortIncompleteMultipartUpload:
          rule.abortIncompleteMultipartUploadDays === undefined
            ? undefined
            : { DaysAfterInitiation: rule.abortIncompleteMultipartUploadDays },
      })),
    },
  });
});

// Deletes every object and version, one page at a time.
const emptyBucket = Effect.fn(function* (bucket: string) {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = yield* S3.listObjectVersions({
      Bucket: bucket,
      KeyMarker: keyMarker,
      VersionIdMarker: versionIdMarker,
    });
    const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].flatMap((v) =>
      v.Key === undefined ? [] : [{ Key: v.Key, VersionId: v.VersionId }],
    );
    if (objects.length > 0) {
      yield* S3.deleteObjects({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } });
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker !== undefined);
});

export const BucketProvider = () =>
  Provider.succeed(Bucket, {
    stables: ["bucketName", "region", "endpoint", "domainName", "url"],
    // A bucket carries no ownership marker.
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output }) {
      const name = output?.bucketName ?? olds.name ?? (yield* physicalName(id));
      const region = output?.region ?? olds.region;
      if (!(yield* exists(name, region))) return undefined;
      const attrs = toAttrs(name, region);
      const owned = output !== undefined || olds.name === undefined;
      return owned ? attrs : Unowned(attrs);
    }),
    diff: Effect.fn(function* ({ id, olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const name = news.name ?? (yield* physicalName(id));
      if (name !== (output?.bucketName ?? name) || news.region !== olds.region) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = output?.bucketName ?? news.name ?? (yield* physicalName(id));
      const region = news.region;
      yield* Effect.gen(function* () {
        if (!(yield* exists(name, region))) {
          yield* S3.createBucket({ Bucket: name }).pipe(
            // A concurrent deploy of this resource created it first.
            Effect.catchTag("BucketAlreadyOwnedByYou", () => Effect.void),
          );
        }
        yield* syncAcl(name, news.acl ?? "private").pipe(Effect.retry(whileNoSuchBucket));
        yield* syncVersioning(name, news.versioning ?? false).pipe(Effect.retry(whileNoSuchBucket));
        yield* syncCors(name, news.cors ?? []).pipe(Effect.retry(whileNoSuchBucket));
        yield* syncLifecycle(name, news.lifecycleRules ?? []).pipe(Effect.retry(whileNoSuchBucket));
      }).pipe(inRegion(region));
      return toAttrs(name, region);
    }),
    delete: Effect.fn(function* ({ olds, output }) {
      yield* Effect.gen(function* () {
        if (!(yield* exists(output.bucketName, output.region))) return;
        if (olds.forceDestroy) yield* emptyBucket(output.bucketName);
        yield* S3.deleteBucket({ Bucket: output.bucketName }).pipe(
          Effect.catchTag("NoSuchBucket", () => Effect.void),
        );
      }).pipe(inRegion(output.region));
    }),
  });
