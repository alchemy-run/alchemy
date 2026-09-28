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
import type { PlatformError } from "effect/PlatformError";
import type { ScopedPlanStatusSession } from "../../Report.ts";
import { sha256, sha256Object } from "../../Util/index.ts";
import { initialCwd } from "../../Util/Node.ts";
import createIgnore from "@alchemy.run/node-utils/ignore";
import picomatch from "picomatch";

const MAX_ASSET_SIZE = 1024 * 1024 * 25; // 25MB
const MAX_ASSET_COUNT = 20_000;

export interface Assets {
  kind: "Cloudflare.Workers.Assets";
}

export const isAssets = (value: any): value is Assets =>
  value?.kind === "Cloudflare.Workers.Assets";

/**
 * Routing configuration for a Worker's static assets — sent to Cloudflare
 * as `metadata.assets.config` on script upload. Declared explicitly (not
 * derived from the distilled API schema) so alchemy owns and documents its
 * public surface.
 */
export interface AssetsConfig {
  /**
   * Determines the redirects and rewrites of requests for HTML content:
   * whether `/page` serves `page.html`, and whether trailing slashes are
   * added or dropped.
   *
   * @default "auto-trailing-slash"
   */
  htmlHandling?:
    | "auto-trailing-slash"
    | "force-trailing-slash"
    | "drop-trailing-slash"
    | "none";
  /**
   * Determines the response when a request does not match a static asset:
   * `"404-page"` serves the nearest `404.html`, and
   * `"single-page-application"` serves `index.html` for client-side
   * routing. When the Worker has a script, an unmatched request falls
   * through to the Worker instead.
   *
   * @default "none"
   */
  notFoundHandling?: "none" | "404-page" | "single-page-application";
  /**
   * Routes requests through the Worker *before* static-asset matching.
   *
   * Assets-first by default: a request matching a file is served directly
   * and never invokes the Worker. `true` routes every request through the
   * Worker ahead of the asset layer — serve files yourself via the
   * `ASSETS` binding. A path-rule array routes only matching paths
   * worker-first (e.g. `["/api/*"]`): glob (`*`) and negative (`!`) rules
   * are supported, rules must start with `/` or `!/`, and negative rules
   * take precedence. The same routing applies under `alchemy dev`.
   *
   * @default false
   */
  runWorkerFirst?: boolean | string[];
  /**
   * Legacy routing flag predating `runWorkerFirst`.
   */
  serveDirectly?: boolean;
  /**
   * Raw contents of a `_headers` file — header rules applied by the asset
   * layer. Overrides a `_headers` file read from the assets directory.
   */
  headers?: string;
  /**
   * Raw contents of a `_redirects` file — redirect rules applied by the
   * asset layer. Overrides a `_redirects` file read from the assets
   * directory.
   */
  redirects?: string;
}

/**
 * An upload manifest: served path → content hash and size.
 */
export type AssetManifest = Record<string, { hash: string; size: number }>;

/**
 * Keep the previous deploy's content-hashed files served for one more
 * deploy. See {@link AssetsProps.retainPrevious}.
 */
export interface RetainPreviousAssets {
  /**
   * Globs, relative to the assets directory, selecting the files to keep
   * for one more deploy (e.g. `["assets/**"]`). Only match content-hashed
   * build output: a retained path is served until the next deploy even
   * though it is no longer in the build.
   */
  paths: string[];
  /**
   * How many previous deploys to keep files from. Only `1` is supported.
   *
   * @default 1
   */
  generations?: 1;
}

export interface AssetReadResult {
  directory: string;
  /**
   * The normalized `base` this manifest was keyed with (`""` when the
   * assets are served from the origin root). Manifest keys are request
   * paths, so `uploadAssets` strips this back off to find each file on
   * disk.
   */
  pathPrefix: string;
  config: AssetsConfig | undefined;
  manifest: AssetManifest;
  _headers: string | undefined;
  _redirects: string | undefined;
  hash: string;
}

export interface AssetsProps extends AssetsConfig {
  directory: string;
  /**
   * The path this site is served from, when it is not the origin root —
   * e.g. `"/docs"` for a Worker on the route `example.com/docs*`. Matches
   * Vite's `base`, and `Website.Vite` fills it in from the resolved Vite
   * config automatically; set it by hand when you bring your own build.
   *
   * Cloudflare's asset router matches request paths against the manifest
   * literally and never strips a prefix, so its model is that the assets
   * directory mirrors the served path. This does that at manifest time:
   * `dist/app.js` is uploaded as `/docs/app.js`, leaving the build output
   * on disk untouched.
   *
   * Bases that name no path — `"/"`, `"./"`, `"https://cdn.example.com/"` —
   * are ignored, as an absolute base means the assets are served by a CDN
   * rather than by this Worker.
   *
   * `_headers` and `_redirects` are NOT rewritten: their rules match the
   * incoming request path, so author them with the full served path
   * (`/docs/old /docs/new 301`).
   *
   * @default undefined (assets are served from the origin root)
   * @see https://developers.cloudflare.com/workers/static-assets/routing/advanced/serving-a-subdirectory/
   */
  base?: string;
  /**
   * Keep serving the previous deploy's files matching `paths` for one more
   * deploy, so a page loaded before a deploy can still fetch the
   * content-hashed chunks it references (e.g. a lazily loaded route).
   *
   * Each deploy records the current build's entries matching `paths` in the
   * Worker's state. The next deploy adds the recorded entries whose paths
   * the new build lacks to its upload manifest. Only the previous build's
   * own files are carried, never files that were themselves carried, so the
   * served set spans at most two builds. Cloudflare's upload session is
   * content-addressed and does not ask for recently uploaded files again,
   * so carrying them moves no bytes; a carried file Cloudflare asks for is
   * dropped from the manifest instead of failing the deploy.
   *
   * `_headers`, `_redirects` and `.assetsignore` are never uploaded, so
   * they are never retained.
   *
   * @example
   * ```ts
   * assets: { retainPrevious: { paths: ["assets/**"] } }
   * ```
   */
  retainPrevious?: RetainPreviousAssets;
}

/**
 * Select the manifest entries matching `retain.paths`: the entries a
 * deploy records so the next deploy can carry them. Globs match the path
 * relative to the assets directory, i.e. the manifest key without the
 * `base` prefix and leading slash. Entries outside the prefix (the SPA
 * `/index.html` alias) never match.
 */
export const selectRetainedAssets = (
  manifest: AssetManifest,
  retain: RetainPreviousAssets,
  pathPrefix = "",
): AssetManifest => {
  const matches = picomatch(retain.paths, { dot: true });
  return Object.fromEntries(
    Object.entries(manifest).filter(
      ([name]) =>
        name.startsWith(`${pathPrefix}/`) &&
        matches(name.slice(pathPrefix.length + 1)),
    ),
  );
};

/**
 * Merge the previous deploy's retained entries into the current upload
 * manifest. A path the current build also has keeps the current entry;
 * every other retained path is added and reported in `carried`.
 */
export const mergeRetainedAssets = (
  manifest: AssetManifest,
  retained: AssetManifest | undefined,
): { manifest: AssetManifest; carried: string[] } => {
  if (retained === undefined) {
    return { manifest, carried: [] };
  }
  const carried = Object.keys(retained)
    .filter((name) => !Object.hasOwn(manifest, name))
    .sort();
  if (carried.length === 0) {
    return { manifest, carried };
  }
  const merged: AssetManifest = { ...manifest };
  for (const name of carried) {
    merged[name] = retained[name];
  }
  return {
    manifest: Object.fromEntries(
      Object.entries(merged).sort((a, b) => a[0].localeCompare(b[0])),
    ),
    carried,
  };
};

/**
 * The carried paths an upload session asked for: their hash is in the
 * session's buckets and no current file has it, so there is nothing to
 * upload. The caller drops them from the manifest.
 */
export const requestedCarriedAssets = (
  manifest: AssetManifest,
  carried: readonly string[],
  requested: ReadonlySet<string>,
  uploadable: ReadonlySet<string>,
): string[] =>
  carried.filter((name) => {
    const hash = manifest[name]?.hash;
    return hash !== undefined && requested.has(hash) && !uploadable.has(hash);
  });

/**
 * `base` → manifest path prefix. Only a root-relative base names a path
 * this Worker serves; `"/"`, `"./"`, protocol-relative and absolute URLs
 * all mean "no prefix".
 */
export const getAssetsPathPrefix = (base: string | undefined) =>
  base?.startsWith("/") && !base.startsWith("//")
    ? base.replace(/\/+$/, "")
    : "";

export type ValidationError =
  | AssetTooLargeError
  | TooManyAssetsError
  | AssetNotFoundError
  | FailedToReadAssetError;

export class AssetTooLargeError extends Data.TaggedError("AssetTooLargeError")<{
  message: string;
  name: string;
  size: number;
}> {}

export class TooManyAssetsError extends Data.TaggedError("TooManyAssetsError")<{
  message: string;
  directory: string;
  count: number;
}> {}

export class AssetNotFoundError extends Data.TaggedError("AssetNotFoundError")<{
  message: string;
  hash: string;
}> {}

export class FailedToReadAssetError extends Data.TaggedError(
  "FailedToReadAssetError",
)<{
  message: string;
  name: string;
  cause: PlatformError;
}> {}

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

const maybeReadString = Effect.fn(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "PlatformError" && error.reason._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  );
});

const createIgnoreMatcher = (patterns: string[]) => {
  const matcher = createIgnore().add(patterns);
  return (file: string) => matcher.ignores(file);
};

/**
 * Read the special `_headers` / `_redirects` files from an assets
 * directory. They are excluded from the upload manifest, but their raw
 * contents must be sent to Cloudflare in the script metadata's asset
 * config (`config._headers` / `config._redirects`) for the rules to
 * apply.
 *
 * The directory is optional: a config-only assets object (e.g. Vite's
 * `assets: { runWorkerFirst: true }`, whose directory is supplied by the
 * build) has no directory to read, and in `dev` there is no build output at
 * all. That yields no rules rather than an error.
 */
export const readAssetsConfigFiles = Effect.fn(function* (
  directory: string | undefined,
) {
  if (directory === undefined) {
    return { _headers: undefined, _redirects: undefined };
  }
  const path = yield* Path.Path;
  // Anchored: see `readAssets` — the directory may be initial-cwd-relative
  // and live cwd reads race concurrent tools' transient chdir.
  const resolvedDirectory = path.resolve(initialCwd, directory);
  const [_headers, _redirects] = yield* Effect.all([
    maybeReadString(path.join(resolvedDirectory, "_headers")),
    maybeReadString(path.join(resolvedDirectory, "_redirects")),
  ]);
  return { _headers, _redirects };
});

/**
 * Merge `_headers` / `_redirects` file contents into an asset config,
 * producing the config to send in the script-upload metadata. Explicit
 * `headers` / `redirects` props win over the files.
 */
export const mergeAssetsConfigFiles = (
  config: AssetsConfig | undefined,
  files: { _headers: string | undefined; _redirects: string | undefined },
): AssetsConfig | undefined => {
  const headers = config?.headers ?? files._headers;
  const redirects = config?.redirects ?? files._redirects;
  if (headers === undefined && redirects === undefined) {
    return config;
  }
  return {
    ...config,
    ...(headers !== undefined ? { headers } : undefined),
    ...(redirects !== undefined ? { redirects } : undefined),
  };
};

export const readAssets = Effect.fn(function* ({
  directory,
  base,
  // Deploy behaviour, not asset content or router config: the Worker
  // provider reads it from props, and it must not reach Cloudflare.
  retainPrevious: _retainPrevious,
  ...config
}: AssetsProps) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // `base` nests the *manifest* paths (what Cloudflare matches request
  // pathnames against) under a prefix; files stay where they are on disk.
  // It is deliberately excluded from the `config` sent to Cloudflare — it
  // is not part of the API's asset config shape.
  const pathPrefix = getAssetsPathPrefix(base);
  // Anchored: `directory` may be a relative path persisted by
  // `Command.Build` (relative to the initial cwd), and a live
  // `process.cwd()` read can race a concurrent tool's transient chdir.
  const resolvedDirectory = path.resolve(initialCwd, directory);
  const [files, ignore, _headers, _redirects] = yield* Effect.all([
    fs.readDirectory(resolvedDirectory, { recursive: true }),
    maybeReadString(path.join(resolvedDirectory, ".assetsignore")),
    maybeReadString(path.join(resolvedDirectory, "_headers")),
    maybeReadString(path.join(resolvedDirectory, "_redirects")),
  ]);
  const ignores = createIgnoreMatcher([
    ".assetsignore",
    "_headers",
    "_redirects",
    ...(ignore
      ?.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")) ?? []),
  ]);
  const manifest = new Map<string, { hash: string; size: number }>();
  let count = 0;
  yield* Effect.forEach(
    files,
    Effect.fn(function* (name) {
      if (ignores(name)) {
        return;
      }
      const file = path.join(resolvedDirectory, name);
      const stat = yield* fs.stat(file);
      if (stat.type !== "File") {
        return;
      }
      const size = Number(stat.size);
      if (size > MAX_ASSET_SIZE) {
        return yield* new AssetTooLargeError({
          message: `Asset ${name} is too large (the maximum size is ${MAX_ASSET_SIZE / 1024 / 1024} MB; this asset is ${size / 1024 / 1024} MB)`,
          name,
          size,
        });
      }
      // Hash content + extension (matching wrangler): the upload API stores
      // one blob + content type per hash, so two identical bodies under
      // different extensions must not collapse into a single entry — the
      // second file would serve with the first file's content type.
      const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
      const hash = yield* fs.readFile(file).pipe(
        Effect.flatMap((content) =>
          Effect.sync(() => {
            const extBytes = new TextEncoder().encode(extension);
            const hashed = new Uint8Array(content.length + extBytes.length);
            hashed.set(content);
            hashed.set(extBytes, content.length);
            return hashed;
          }),
        ),
        Effect.flatMap(sha256),
        Effect.map((hash) => hash.slice(0, 32)),
      );
      count++;
      if (count > MAX_ASSET_COUNT) {
        return yield* new TooManyAssetsError({
          message: `Too many assets (the maximum count is ${MAX_ASSET_COUNT}; this directory has ${count} assets)`,
          directory,
          count,
        });
      }
      manifest.set(
        `${pathPrefix}${(name.startsWith("/") ? name : `/${name}`).replaceAll("\\", "/")}`,
        {
          hash,
          size,
        },
      );
    }),
  );
  // Cloudflare's SPA fallback is hard-coded to `/index.html` at the
  // manifest root, so prefixing every key would 404 every client-side
  // route under the base. Alias the shell back to the root — one extra
  // manifest line, zero extra uploads, since entries are content-addressed.
  const indexHtml = manifest.get(`${pathPrefix}/index.html`);
  if (
    indexHtml &&
    config.notFoundHandling === "single-page-application" &&
    !manifest.has("/index.html")
  ) {
    manifest.set("/index.html", indexHtml);
  }
  const sortedManifest = Object.fromEntries(
    Array.from(manifest.entries()).sort((a, b) => a[0].localeCompare(b[0])),
  );
  // Hash only inputs that affect what gets uploaded — the file
  // manifest, asset config, and the special `_headers` / `_redirects`
  // files. `directory` is deliberately excluded: identical bytes at a
  // different absolute path must produce the same hash, otherwise
  // diffing across machines (CI runner → local laptop, monorepo
  // root → workspace root, etc.) spuriously reports "changed" and
  // causes both unnecessary re-uploads and `NotFound` failures when
  // the previously-recorded path is gone.
  const hash = yield* sha256Object({
    config,
    manifest: sortedManifest,
    _headers,
    _redirects,
  });
  return {
    directory,
    pathPrefix,
    // Fold the `_headers` / `_redirects` file contents into the config
    // that gets sent to Cloudflare (`metadata.assets.config`). Merged
    // *after* hashing so the hash input shape stays stable for
    // already-deployed workers. Deliberately NOT `base`-prefixed: their
    // rules match the incoming request path, which already carries the
    // base, so they are authored with the full served path.
    config: mergeAssetsConfigFiles(config, { _headers, _redirects }),
    manifest: sortedManifest,
    _headers,
    _redirects,
    hash,
  };
});

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
  /**
   * The previous deploy's retained entries (see
   * {@link AssetsProps.retainPrevious}). Paths the current build lacks are
   * added to the upload manifest.
   */
  retained?: AssetManifest,
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
  // Carried entries have no file on disk. Cloudflare keeps recently
  // uploaded content and does not ask for it again; a carried hash it does
  // ask for is dropped from `manifest` and the session restarts without
  // it. Hoisted so a session retry keeps the reduced manifest.
  let { manifest, carried } = mergeRetainedAssets(assets.manifest, retained);
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
  const createSession = () =>
    dispatchNamespace
      ? wfp.createDispatchNamespaceScriptAssetUpload({
          accountId,
          dispatchNamespace,
          scriptName: workerName,
          manifest,
        })
      : workers.createScriptAssetUpload({
          accountId,
          scriptName: workerName,
          manifest,
        });

  const runSession = Effect.fn(function* () {
    yield* note("Checking assets...", { kind: "status" });
    let session = yield* createSession();
    // Each pass drops at least one carried path, so this ends.
    while (true) {
      const unavailable = requestedCarriedAssets(
        manifest,
        carried,
        new Set(session.buckets?.flat()),
        new Set(assetsByHash.keys()),
      );
      if (unavailable.length === 0) {
        break;
      }
      yield* Effect.logWarning(
        `Asset upload for worker ${workerName}: ${unavailable.length} retained asset(s) of the previous deploy are no longer stored and are not carried: ${unavailable.join(", ")}`,
      );
      const drop = new Set(unavailable);
      manifest = Object.fromEntries(
        Object.entries(manifest).filter(([name]) => !drop.has(name)),
      );
      carried = carried.filter((name) => !drop.has(name));
      session = yield* createSession();
    }
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
  return { jwt, carried };
});
