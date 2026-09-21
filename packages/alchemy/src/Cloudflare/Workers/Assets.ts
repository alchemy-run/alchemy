import {
  type AssetReadResult,
  AssetNotFoundError,
  FailedToReadAssetError,
} from "@alchemy.run/cloudflare-runtime/vite/assets";
export {
  type AssetsConfig,
  type AssetsProps,
  type AssetReadResult,
  type ValidationError,
  AssetTooLargeError,
  TooManyAssetsError,
  AssetNotFoundError,
  FailedToReadAssetError,
  readAssets,
  readAssetsConfigFiles,
  mergeAssetsConfigFiles,
  getAssetsPathPrefix,
} from "@alchemy.run/cloudflare-runtime/vite/assets";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as wfp from "@distilled.cloud/cloudflare/workers-for-platforms";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import type { ScopedPlanStatusSession } from "../../Report.ts";
import { initialCwd } from "../../Util/Node.ts";

export interface Assets {
  kind: "Cloudflare.Workers.Assets";
}

export const isAssets = (value: any): value is Assets =>
  value?.kind === "Cloudflare.Workers.Assets";

export class AssetUploadSessionError extends Data.TaggedError(
  "AssetUploadSessionError",
)<{
  message: string;
  workerName: string;
}> {}

const contentTypesByExtension: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
  md: "text/markdown",
  sql: "text/sql",
  json: "application/json",
  // Source maps are JSON; serving them as such lets devtools consume them.
  map: "application/json",
  jsonld: "application/ld+json",
  xml: "application/xml",
  csv: "text/csv",
  // Browsers only accept JavaScript module scripts when the MIME type is a
  // "JavaScript MIME type" (e.g. text/javascript). application/javascript+module
  // is not valid and causes strict module loading to fail.
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css",
  wasm: "application/wasm",
  pdf: "application/pdf",
  // images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  // fonts
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  // media
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  // app manifests
  webmanifest: "application/manifest+json",
};

const getContentType = (name: string) => {
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
  return contentTypesByExtension[ext] ?? "application/octet-stream";
};

/**
 * Bulk buckets (up to ~50 MiB of base64 each) go up this many at a time —
 * the same number wrangler uses.
 */
const BULK_UPLOAD_CONCURRENCY = 3;
/**
 * Per-bucket retries after a gateway error (502/503/504), with concurrency
 * already dropped to one. Mirrors wrangler's `MAX_UPLOAD_GATEWAY_ERRORS`.
 */
const MAX_UPLOAD_GATEWAY_RETRIES = 5;

const isGatewayError = (error: unknown) =>
  Predicate.isTagged(error, "BadGateway") ||
  Predicate.isTagged(error, "ServiceUnavailable") ||
  Predicate.isTagged(error, "GatewayTimeout");

/**
 * The SDK's default policy retries gateway errors internally (~20s of
 * backoff) before the caller ever sees one, so the concurrency fallback
 * below could never kick in. Let those surface to the bucket loop; every
 * other transient error keeps the default handling.
 */
const surfaceGatewayErrors: Retry.Factory = (lastError) => {
  const base = Retry.makeDefault(lastError);
  return {
    ...base,
    while: (error) => !isGatewayError(error) && (base.while?.(error) ?? false),
  };
};

export const uploadAssets = Effect.fn(function* (
  accountId: string,
  workerName: string,
  assets: AssetReadResult,
  { note }: ScopedPlanStatusSession,
  dispatchNamespace?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const createAssetUpload = yield* workers.createAssetUpload;

  // Manifest keys are the paths Cloudflare *serves*, so they carry the
  // `base` prefix. The files themselves are on disk at the un-prefixed
  // path relative to the assets directory, so drop the prefix to get
  // back to something `readFile` can open.
  const toDiskPath = (name: string) =>
    assets.pathPrefix && name.startsWith(`${assets.pathPrefix}/`)
      ? name.slice(assets.pathPrefix.length)
      : name;

  const assetsByHash = new Map<string, string>();
  for (const [name, { hash }] of Object.entries(assets.manifest)) {
    assetsByHash.set(hash, toDiskPath(name));
  }
  // Anchored: `assets.directory` may be relative to the initial cwd (a
  // `Command.Build` outdir), and a live `process.cwd()` read can race a
  // concurrent tool's transient chdir (framework source builds).
  const directory = path.resolve(initialCwd, assets.directory);

  // Bucket concurrency, wrangler-style: three in flight, and the first
  // gateway error resizes it to one for the rest of the deploy. Hoisted out
  // of the session so a JWT-expiry retry stays degraded instead of bursting
  // back to three against a gateway that just told us to back off.
  const semaphore = yield* Semaphore.make(BULK_UPLOAD_CONCURRENCY);

  const uploadBucket = Effect.fn(function* (
    bucket: readonly string[],
    uploadJwt: string,
  ) {
    const body: Record<string, File> = {};
    yield* Effect.forEach(
      bucket,
      Effect.fn(function* (hash) {
        const name = assetsByHash.get(hash);
        if (!name) {
          return yield* new AssetNotFoundError({
            message: `Asset ${hash} not found in manifest`,
            hash,
          });
        }
        const file = yield* fs.readFile(path.join(directory, name)).pipe(
          Effect.mapError(
            (error) =>
              new FailedToReadAssetError({
                message: `Failed to read asset ${name}: ${error.message}`,
                name,
                cause: error,
              }),
          ),
        );
        body[hash] = new File([Buffer.from(file).toString("base64")], hash, {
          type: getContentType(name),
        });
      }),
    );
    return yield* createAssetUpload({
      accountId,
      base64: true,
      body,
      jwtToken: uploadJwt,
    }).pipe(
      Retry.policy(surfaceGatewayErrors),
      Effect.tapError((error) =>
        isGatewayError(error)
          ? semaphore
              .resize(1)
              .pipe(
                Effect.andThen(
                  note(
                    "Asset upload hit a gateway error, retrying one bucket at a time...",
                    { kind: "status" },
                  ),
                ),
              )
          : Effect.void,
      ),
      Effect.retry({
        while: isGatewayError,
        schedule: Schedule.exponential("2 seconds"),
        times: MAX_UPLOAD_GATEWAY_RETRIES,
      }),
    );
  });

  // One full upload session: ask Cloudflare which assets are missing,
  // upload each bucket, and return the completion JWT that putWorker
  // must redeem. The session JWT can expire mid-upload on very large
  // asset sets (Unauthorized), and the final bucket response has been
  // observed in the wild to omit the completion JWT — both cases are
  // retried below with a fresh session. Already-uploaded assets are
  // not re-bucketed, so a retry resumes where the last session
  // stopped, and a fresh session with nothing left to upload returns
  // the completion JWT directly.
  const runSession = Effect.fn(function* () {
    yield* note("Checking assets...", { kind: "status" });
    const session = dispatchNamespace
      ? yield* wfp.createDispatchNamespaceScriptAssetUpload({
          accountId,
          dispatchNamespace,
          scriptName: workerName,
          manifest: assets.manifest,
        })
      : yield* workers.createScriptAssetUpload({
          accountId,
          scriptName: workerName,
          manifest: assets.manifest,
        });
    if (!session.buckets?.length) {
      if (!session.jwt) {
        return yield* new AssetUploadSessionError({
          message: `Asset upload session for worker ${workerName} returned no completion token`,
          workerName,
        });
      }
      return session.jwt;
    }
    if (!session.jwt) {
      return yield* new AssetUploadSessionError({
        message: `Asset upload session for worker ${workerName} returned ${session.buckets.length} buckets to upload but no upload token`,
        workerName,
      });
    }
    const uploadJwt = session.jwt;
    let uploaded = 0;
    const total = session.buckets.flat().length;
    yield* note(`Uploaded ${uploaded} of ${total} assets...`);
    // Cloudflare only returns the completion JWT on the last bucket it
    // receives, which under concurrency is not necessarily the last one
    // in the list — so every response is checked.
    let jwt: string | undefined | null;
    yield* Effect.forEach(
      session.buckets,
      Effect.fn(function* (bucket) {
        const result = yield* uploadBucket(bucket, uploadJwt).pipe(
          semaphore.withPermits(1),
        );
        uploaded += bucket.length;
        yield* note(`Uploaded ${uploaded} of ${total} assets...`);
        if (result.jwt) {
          jwt = result.jwt;
        }
      }),
      { concurrency: BULK_UPLOAD_CONCURRENCY },
    );
    if (!jwt) {
      return yield* new AssetUploadSessionError({
        message: `Uploaded ${total} assets for worker ${workerName} but Cloudflare did not return a completion token`,
        workerName,
      });
    }
    return jwt;
  });

  const jwt = yield* runSession().pipe(
    Effect.retry({
      while: (error): boolean =>
        error._tag === "Unauthorized" ||
        error._tag === "AssetUploadSessionError",
      schedule: Schedule.exponential("1 second"),
      times: 3,
    }),
  );
  return { jwt };
});
