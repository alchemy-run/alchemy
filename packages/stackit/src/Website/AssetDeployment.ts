import { createHash } from "node:crypto";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { withDeployerS3 } from "../ObjectStorage/internal.ts";
import type { Providers } from "../Providers.ts";
import {
  cacheControlFor,
  contentTypeFor,
  md5,
  normalizePrefix,
  objectKeysOf,
  purgeableFiles,
  resolveSource,
  SERVE_ENTRY_FILE,
  walkFiles,
} from "./internal.ts";

export interface AssetDeploymentProps {
  /** Name of the destination bucket. */
  bucketName: string;
  /** Path-style URL of the bucket, which also gives the S3 endpoint. */
  urlPathStyle: string;
  /** Project of the bucket. */
  projectId: string;
  /** Region of the bucket. */
  region: string;
  /** Local directory to upload. */
  sourcePath: string;
  /**
   * Hash of the build that produced `sourcePath`. A new value uploads again; an
   * unchanged one leaves the bucket alone.
   */
  buildHash?: string | undefined;
  /**
   * Key prefix within the bucket, the site's base path. Changing it moves the files: the
   * next deploy deletes what it wrote under the old one.
   */
  prefix?: string;
  /**
   * Also delete every other object under the prefix, or in the whole bucket without one,
   * including objects this deployment never wrote. Only for a bucket that holds nothing
   * else.
   * @default false
   */
  purge?: boolean;
  /**
   * `drop-trailing-slash` also stores `about.html` at `about`.
   * @default "none"
   */
  htmlHandling?: "none" | "drop-trailing-slash";
}

export type AssetDeployment = Resource<
  "Stackit.Website.AssetDeployment",
  AssetDeploymentProps,
  {
    /** Name of the destination bucket. */
    bucketName: string;
    /** Normalized key prefix; an empty string when there is none. */
    prefix: string;
    /** Hash of the uploaded files, their names and their headers. */
    version: string;
    /** Every object key this deployment wrote, sorted. */
    keys: string[];
    /** The unhashed files by URL path, with a hash of each one's content. */
    purgeable: Record<string, string>;
    /** The bucket's project. */
    projectId: string;
    /** The bucket's region. */
    region: string;
    /** Path-style URL of the bucket. */
    urlPathStyle: string;
  },
  never,
  Providers
>;

/**
 * Upload a local directory to a `Stackit.ObjectStorage.Bucket` with website
 * headers: files with a content hash in their name are immutable, HTML is never
 * cached, and anything else is revalidated. An object already holding a file's
 * bytes isn't uploaded again. Keys an earlier deploy of this resource wrote that are no
 * longer in the directory are deleted, and so are all of them after a move to another
 * bucket or prefix. Anything else in the bucket stays, unless `purge` is set.
 *
 * A page also gets a copy at the URLs frameworks link to (`about/index.html` at
 * `about` and `about/`), because a bucket has no directory index and the CDN no
 * rewrite. Files are uploaded before pages, so a page never refers to a file that
 * isn't there yet.
 *
 * The bucket's S3 API takes only Object Storage keys, so each deploy mints a
 * short-lived key in the project's `default` credentials group, and deletes it
 * afterwards. `Stackit.Website.StaticSite` and the framework sites use this
 * internally. Reach for it directly when you manage the bucket and the CDN
 * yourself. A destroy removes the keys it wrote.
 *
 * ### Deploying Files
 * **Example:** Upload a build directory
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const bucket = yield* Stackit.ObjectStorage.Bucket("Site", {});
 * const files = yield* Stackit.Website.AssetDeployment("SiteFiles", {
 *   bucketName: bucket.bucketName,
 *   urlPathStyle: bucket.urlPathStyle,
 *   projectId: bucket.projectId,
 *   region: bucket.region,
 *   sourcePath: "./dist",
 * });
 * ```
 *
 * **Example:** Sweep a bucket that holds nothing else
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const bucket = yield* Stackit.ObjectStorage.Bucket("Site", {});
 * const files = yield* Stackit.Website.AssetDeployment("SiteFiles", {
 *   bucketName: bucket.bucketName,
 *   urlPathStyle: bucket.urlPathStyle,
 *   projectId: bucket.projectId,
 *   region: bucket.region,
 *   sourcePath: "./dist",
 *   purge: true,
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const AssetDeployment = Resource<AssetDeployment>("Stackit.Website.AssetDeployment");

/** The source directory holds nothing to upload; deleting the live site can't be what's meant. */
export class AssetSourceEmpty extends Data.TaggedError("Stackit.Website.AssetSourceEmpty")<{
  readonly resourceName: string;
  readonly sourcePath: string;
  readonly message: string;
}> {}

const listObjects = (bucketName: string, prefix: string) =>
  s3.listObjectsV2
    .pages({ Bucket: bucketName, Prefix: prefix === "" ? undefined : `${prefix}/` })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.Contents ?? [])),
      Stream.runFold(
        () => new Map<string, string>(),
        (out, item) => {
          if (item.Key !== undefined) out.set(item.Key, (item.ETag ?? "").replace(/^"|"$/g, ""));
          return out;
        },
      ),
    );

const deleteKeys = Effect.fn(function* (bucketName: string, keys: ReadonlyArray<string>) {
  for (let index = 0; index < keys.length; index += 1000) {
    yield* s3.deleteObjects({
      Bucket: bucketName,
      Delete: {
        Objects: keys.slice(index, index + 1000).map((Key) => ({ Key })),
        Quiet: true,
      },
    });
  }
});

export const AssetDeploymentProvider = () =>
  Provider.succeed(AssetDeployment, {
    // Nothing to enumerate: the objects belong to their bucket.
    list: () => Effect.succeed([]),

    // The objects are observed at reconcile, which is when a new build lands.
    read: ({ output }) => Effect.succeed(output),

    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* resolveSource(news.sourcePath);
      const prefix = normalizePrefix(news.prefix);
      const names = (yield* walkFiles(root)).filter((file) => file !== SERVE_ENTRY_FILE);
      if (names.length === 0) {
        return yield* new AssetSourceEmpty({
          resourceName: id,
          sourcePath: root,
          message: `${id}: ${root} holds no files, so the site's objects were left in place`,
        });
      }
      const files = yield* Effect.forEach(
        names,
        (relative) =>
          Effect.gen(function* () {
            const body = yield* fs.readFile(path.join(root, relative));
            return {
              relative,
              body,
              etag: yield* md5(body),
              keys: objectKeysOf(relative, { prefix, htmlHandling: news.htmlHandling }),
              contentType: contentTypeFor(relative),
              cacheControl: cacheControlFor(relative),
            };
          }),
        { concurrency: 32 },
      );
      const objects = files.flatMap((file) => file.keys.map((key) => ({ ...file, key })));
      const desired = new Set(objects.map((object) => object.key));
      // `output` only speaks for keys in this bucket. A prefix move stays in it.
      const sameBucket =
        output?.bucketName === news.bucketName &&
        output.projectId === news.projectId &&
        output.region === news.region;

      const uploaded = yield* withDeployerS3(
        {
          projectId: news.projectId,
          region: news.region,
          bucketName: news.bucketName,
          urlPathStyle: news.urlPathStyle,
        },
        Effect.gen(function* () {
          const observed = yield* listObjects(news.bucketName, prefix).pipe(
            // A bucket that was just created may not be visible to S3 yet.
            Effect.retry({
              while: (error) => error._tag === "NoSuchBucket",
              schedule: Schedule.spaced("3 seconds"),
              times: 10,
            }),
          );
          const missing = objects.filter((object) => observed.get(object.key) !== object.etag);
          const put = (batch: typeof missing) =>
            Effect.forEach(
              batch,
              (object) =>
                s3.putObject({
                  Bucket: news.bucketName,
                  Key: object.key,
                  Body: object.body,
                  ContentType: object.contentType,
                  CacheControl: object.cacheControl,
                }),
              { concurrency: 16, discard: true },
            );
          yield* put(missing.filter((object) => !object.contentType.startsWith("text/html")));
          yield* put(missing.filter((object) => object.contentType.startsWith("text/html")));
          // Only what this resource wrote: the bucket can hold what it didn't.
          const stale = new Set([
            ...(sameBucket ? (output?.keys ?? []) : []),
            ...(news.purge === true ? observed.keys() : []),
          ]);
          yield* deleteKeys(
            news.bucketName,
            [...stale].filter((key) => !desired.has(key)),
          );
          return missing.length;
        }),
      );
      // The files moved to another bucket, so what was written to the old one is stale.
      if (output !== undefined && !sameBucket) {
        yield* withDeployerS3(
          {
            projectId: output.projectId,
            region: output.region,
            bucketName: output.bucketName,
            urlPathStyle: output.urlPathStyle,
          },
          deleteKeys(output.bucketName, output.keys),
        ).pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));
      }
      yield* session.note(`Uploaded ${uploaded} of ${objects.length} objects`);

      const version = yield* Effect.sync(() => {
        const hash = createHash("sha256");
        for (const file of files) {
          hash.update(
            `${file.relative}\0${file.etag}\0${file.contentType}\0${file.cacheControl}\0`,
          );
        }
        return hash.digest("hex");
      });
      return {
        bucketName: news.bucketName,
        prefix,
        version,
        keys: [...desired].sort(),
        purgeable: yield* purgeableFiles(root, { prefix, htmlHandling: news.htmlHandling }),
        projectId: news.projectId,
        region: news.region,
        urlPathStyle: news.urlPathStyle,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* withDeployerS3(
        {
          projectId: output.projectId,
          region: output.region,
          bucketName: output.bucketName,
          urlPathStyle: output.urlPathStyle,
        },
        deleteKeys(output.bucketName, output.keys),
      ).pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));
    }),
  });
