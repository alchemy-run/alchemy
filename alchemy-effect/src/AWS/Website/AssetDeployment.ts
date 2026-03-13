import * as s3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Input } from "../../Input.ts";
import { Resource } from "../../Resource.ts";
import type { Bucket, BucketName } from "../S3/Bucket.ts";

export interface AssetFileOption {
  /**
   * Glob or globs of files to match.
   */
  files: string | string[];
  /**
   * Override `Content-Type` for matched files.
   */
  contentType?: string;
  /**
   * Override `Cache-Control` for matched files.
   */
  cacheControl?: string;
}

export interface AssetDeploymentProps {
  /**
   * Destination bucket.
   */
  bucket: Input<BucketName> | Bucket | { bucketName: Input<BucketName> };
  /**
   * Local directory to upload.
   */
  sourcePath: Input<string>;
  /**
   * Optional key prefix within the bucket.
   */
  prefix?: string;
  /**
   * Remove old files under the prefix that are not part of the current deploy.
   * @default false
   */
  purge?: boolean;
  /**
   * Optional per-file overrides.
   */
  fileOptions?: AssetFileOption[];
}

export interface AssetDeployment extends Resource<
  "AWS.Website.AssetDeployment",
  AssetDeploymentProps,
  {
    bucketName: string;
    prefix: string;
    version: string;
    fileCount: number;
  }
> {}

/**
 * Upload a local directory into S3 with website-friendly defaults.
 *
 * `AssetDeployment` is a helper resource for website hosting. It uploads all
 * files in a directory, infers content types, applies cache-control defaults,
 * and can optionally purge stale files under a prefix.
 *
 * @section Deploying Files
 * @example Upload A Build Directory
 * ```typescript
 * const files = yield* AssetDeployment("WebsiteFiles", {
 *   bucket,
 *   sourcePath: "./dist",
 *   prefix: "_assets",
 * });
 * ```
 */
export const AssetDeployment = Resource<AssetDeployment>(
  "AWS.Website.AssetDeployment",
);

const defaultHtmlCacheControl = "max-age=0,no-cache,no-store,must-revalidate";
const defaultAssetCacheControl = "max-age=31536000,public,immutable";

const bucketNameOf = (bucket: AssetDeploymentProps["bucket"]) =>
  typeof bucket === "string"
    ? bucket
    : (((bucket as any).bucketName ?? bucket) as string);

const normalizePrefix = (prefix: string | undefined) =>
  prefix ? prefix.replace(/^\/+|\/+$/g, "") : "";

const toPosix = (value: string) => value.split(path.sep).join("/");

const inferContentType = (file: string) => {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".xml":
      return "application/xml; charset=utf-8";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
};

const defaultCacheControlFor = (file: string) =>
  path.extname(file).toLowerCase() === ".html"
    ? defaultHtmlCacheControl
    : defaultAssetCacheControl;

const escapeRegex = (value: string) =>
  value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");

const globToRegExp = (glob: string) =>
  new RegExp(
    `^${escapeRegex(toPosix(glob))
      .replace(/\\\*\\\*/g, ".*")
      .replace(/\\\*/g, "[^/]*")
      .replace(/\\\?/g, ".")}$`,
  );

const matchesAny = (file: string, globs: string | string[]) =>
  (Array.isArray(globs) ? globs : [globs]).some((glob) =>
    globToRegExp(glob).test(file),
  );

const getFileOptions = (
  file: string,
  options: AssetFileOption[] | undefined,
): {
  contentType: string;
  cacheControl: string;
} => {
  const matched = [...(options ?? [])].reverse().find((option) =>
    matchesAny(file, option.files),
  );

  return {
    contentType: matched?.contentType ?? inferContentType(file),
    cacheControl: matched?.cacheControl ?? defaultCacheControlFor(file),
  };
};

const walk = async (root: string, dir = ""): Promise<string[]> => {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return walk(root, relative);
      }
      return [relative];
    }),
  );
  return files.flat();
};

const listKeys = Effect.fn(function* (bucketName: string, prefix: string) {
  let continuationToken: string | undefined;
  const keys: string[] = [];

  do {
    const response = yield* s3.listObjectsV2({
      Bucket: bucketName,
      Prefix: prefix || undefined,
      ContinuationToken: continuationToken,
    });
    keys.push(...(response.Contents ?? []).flatMap((item) => (item.Key ? [item.Key] : [])));
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return keys;
});

const deleteKeys = Effect.fn(function* (bucketName: string, keys: string[]) {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    if (batch.length === 0) {
      continue;
    }
    yield* s3.deleteObjects({
      Bucket: bucketName,
      Delete: {
        Objects: batch.map((Key) => ({ Key })),
        Quiet: true,
      },
    });
  }
});

export const AssetDeploymentProvider = () =>
  AssetDeployment.provider.effect(
    Effect.gen(function* () {
      const sync = Effect.fn(function* (news: AssetDeploymentProps) {
        const bucketName = bucketNameOf(news.bucket);
        const prefix = normalizePrefix(news.prefix);
        const root = news.sourcePath as string;
        const files = yield* Effect.tryPromise(() => walk(root));
        const hash = createHash("sha256");
        const desiredKeys = new Set<string>();

        for (const relativePath of files.sort((a, b) => a.localeCompare(b))) {
          const body = yield* Effect.tryPromise(() =>
            readFile(path.join(root, relativePath)),
          );
          const normalizedRelativePath = toPosix(relativePath);
          const key = prefix
            ? `${prefix}/${normalizedRelativePath}`
            : normalizedRelativePath;
          const options = getFileOptions(normalizedRelativePath, news.fileOptions);

          hash.update(normalizedRelativePath);
          hash.update(body);
          hash.update(options.contentType);
          hash.update(options.cacheControl);

          desiredKeys.add(key);

          yield* s3.putObject({
            Bucket: bucketName,
            Key: key,
            Body: body,
            ContentType: options.contentType,
            CacheControl: options.cacheControl,
          });
        }

        if (news.purge ?? false) {
          const existingKeys = yield* listKeys(
            bucketName,
            prefix ? `${prefix}/` : prefix,
          );
          const staleKeys = existingKeys.filter((key) => !desiredKeys.has(key));
          yield* deleteKeys(bucketName, staleKeys);
        }

        return {
          bucketName,
          prefix,
          version: hash.digest("hex"),
          fileCount: files.length,
        };
      });

      return {
        read: Effect.fn(function* ({ output }) {
          return output;
        }),
        create: Effect.fn(function* ({ news, session }) {
          const output = yield* sync(news);
          yield* session.note(
            `Uploaded ${output.fileCount} file(s) to s3://${output.bucketName}/${output.prefix}`,
          );
          return output;
        }),
        update: Effect.fn(function* ({ news, session }) {
          const output = yield* sync(news);
          yield* session.note(
            `Uploaded ${output.fileCount} file(s) to s3://${output.bucketName}/${output.prefix}`,
          );
          return output;
        }),
        delete: Effect.fn(function* ({ olds, output }) {
          if (!(olds.purge ?? false)) {
            return;
          }
          const prefix = output.prefix ? `${output.prefix}/` : output.prefix;
          const existingKeys = yield* listKeys(output.bucketName, prefix);
          yield* deleteKeys(output.bucketName, existingKeys);
        }),
      };
    }),
  );
