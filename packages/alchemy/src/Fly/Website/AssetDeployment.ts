import { Credentials, fromCredentials } from "@distilled.cloud/aws/Credentials";
import * as AwsEndpoint from "@distilled.cloud/aws/Endpoint";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { createHash } from "node:crypto";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { initialCwd } from "../../Util/Node.ts";
import type { Bucket } from "../Bucket.ts";
import { TigrisCredentialsMissing } from "../Errors.ts";
import type { Providers } from "../Providers.ts";

const htmlCacheControl = "max-age=0,no-cache,no-store,must-revalidate";
const assetCacheControl = "max-age=31536000,public,immutable";

const contentTypeOf = (relative: string): string => {
  const ext = relative.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "js":
    case "mjs":
      return "text/javascript; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "json":
      return "application/json";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "ico":
      return "image/x-icon";
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    case "txt":
      return "text/plain; charset=utf-8";
    case "wasm":
      return "application/wasm";
    case "map":
      return "application/json";
    default:
      return "application/octet-stream";
  }
};

const cacheControlOf = (relative: string): string =>
  relative.endsWith(".html") || relative.endsWith(".htm")
    ? htmlCacheControl
    : assetCacheControl;

const asPlain = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) return value;
  if (Redacted.isRedacted(value)) {
    const inner = Redacted.value(value);
    return typeof inner === "string" && inner.length > 0 ? inner : undefined;
  }
  return undefined;
};

export interface AssetDeploymentProps {
  /**
   * Destination Tigris bucket (a {@link Bucket} resource).
   */
  bucket: Bucket;
  /**
   * Local directory to upload (framework `clientDirectory`).
   */
  sourcePath: string;
  /**
   * Optional key prefix within the bucket.
   */
  prefix?: string;
  /**
   * Delete observed keys under the prefix that are not in this deploy.
   * @default true
   */
  purge?: boolean;
}

export interface AssetDeployment extends Resource<
  "Fly.Website.AssetDeployment",
  AssetDeploymentProps,
  {
    bucketName: string;
    prefix: string;
    version: string;
    fileCount: number;
    files: string[];
  },
  never,
  Providers
> {}

/**
 * Upload a local directory into a public Tigris bucket for Fly Website
 * statics. HTML is never cached; everything else is immutable.
 *
 * @resource
 */
export const AssetDeployment = Resource<AssetDeployment>(
  "Fly.Website.AssetDeployment",
);

const normalizePrefix = (prefix: string | undefined) =>
  prefix ? prefix.replace(/^\/+|\/+$/g, "") : "";

const scopeOf = (bucket: Bucket) =>
  Effect.gen(function* () {
    const bucketName = asPlain(bucket.bucketName) ?? asPlain(bucket.name);
    const accessKeyId = asPlain(bucket.accessKeyId);
    const secretAccessKey = asPlain(bucket.secretAccessKey);
    const endpoint = asPlain(bucket.endpoint);
    const region = (asPlain(bucket.region) ?? "auto") as RegionName;
    if (
      bucketName === undefined ||
      accessKeyId === undefined ||
      secretAccessKey === undefined ||
      endpoint === undefined
    ) {
      return yield* new TigrisCredentialsMissing({
        name: bucketName ?? bucket.LogicalId,
      });
    }
    return { bucketName, accessKeyId, secretAccessKey, endpoint, region };
  });

const withTigris = <A, E>(
  scope: {
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    region: RegionName;
  },
  operation: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
) =>
  operation.pipe(
    Effect.provide(
      fromCredentials(
        {
          accessKeyId: scope.accessKeyId,
          secretAccessKey: scope.secretAccessKey,
        },
        scope.region,
      ),
    ),
    Effect.provide(AwsEndpoint.of(scope.endpoint)),
    Effect.provide(FetchHttpClient.layer),
  );

const walkFiles = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(root))) return [] as string[];
  const names = yield* fs.readDirectory(root, { recursive: true });
  const files: string[] = [];
  for (const name of names) {
    const full = path.join(root, name);
    const stat = yield* fs.stat(full);
    if (stat.type === "File") files.push(name.replaceAll("\\", "/"));
  }
  return files.sort((a, b) => a.localeCompare(b));
});

const listObserved = Effect.fn(function* (
  scope: {
    bucketName: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    region: RegionName;
  },
  prefix: string,
) {
  const observed = new Map<string, string | undefined>();
  let token: string | undefined;
  for (let page = 0; page < 50; page++) {
    const result = yield* withTigris(
      scope,
      s3.listObjectsV2({
        Bucket: scope.bucketName,
        Prefix: prefix.length > 0 ? `${prefix}/` : undefined,
        ContinuationToken: token,
      }),
    );
    for (const object of result.Contents ?? []) {
      if (object.Key !== undefined) observed.set(object.Key, object.ETag);
    }
    if (result.IsTruncated !== true) break;
    token = result.NextContinuationToken;
    if (token === undefined) break;
  }
  return observed;
});

export const AssetDeploymentProvider = () =>
  Provider.effect(
    AssetDeployment,
    Effect.succeed({
      list: () => Effect.succeed([]),
      read: Effect.fn(function* ({ output }) {
        return output;
      }),
      reconcile: Effect.fn(function* ({ news, session }) {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const scope = yield* scopeOf(news.bucket);
        const prefix = normalizePrefix(news.prefix);
        const root = path.isAbsolute(news.sourcePath)
          ? news.sourcePath
          : path.resolve(initialCwd, news.sourcePath);
        const files = yield* walkFiles(root);
        const hash = createHash("sha256");
        const desired = new Set<string>();
        const uploaded: string[] = [];
        const observed = yield* listObserved(scope, prefix);

        for (const relative of files) {
          const body = yield* fs.readFile(path.join(root, relative));
          const key = prefix.length > 0 ? `${prefix}/${relative}` : relative;
          const contentType = contentTypeOf(relative);
          const cacheControl = cacheControlOf(relative);
          hash.update(relative);
          hash.update(body);
          hash.update(contentType);
          hash.update(cacheControl);
          desired.add(key);
          uploaded.push(relative);
          const expected = createHash("md5").update(body).digest("hex");
          const etag = observed.get(key)?.replace(/^"|"$/g, "");
          if (etag === expected) continue;
          yield* withTigris(
            scope,
            s3.putObject({
              Bucket: scope.bucketName,
              Key: key,
              Body: body,
              ContentType: contentType,
              CacheControl: cacheControl,
            }),
          );
        }

        if (news.purge ?? true) {
          const stale = [...observed.keys()].filter((key) => !desired.has(key));
          for (const key of stale) {
            yield* withTigris(
              scope,
              s3.deleteObject({
                Bucket: scope.bucketName,
                Key: key,
              }),
            ).pipe(Effect.catchTag("NoSuchKey", () => Effect.void));
          }
        }

        const output = {
          bucketName: scope.bucketName,
          prefix,
          version: hash.digest("hex"),
          fileCount: files.length,
          files: uploaded,
        };
        yield* session.note(
          `Uploaded ${output.fileCount} file(s) to tigris://${output.bucketName}/${output.prefix}`,
        );
        return output;
      }),
      delete: Effect.fn(function* ({ olds, output }) {
        if (!(olds.purge ?? true)) return;
        const scope = yield* scopeOf(olds.bucket);
        const observed = yield* listObserved(scope, output.prefix);
        for (const key of observed.keys()) {
          yield* withTigris(
            scope,
            s3.deleteObject({
              Bucket: scope.bucketName,
              Key: key,
            }),
          ).pipe(Effect.catchTag("NoSuchKey", () => Effect.void));
        }
      }),
    }),
  );
