import { createHash } from "node:crypto";
import { initialCwd } from "alchemy/Util/Node";
import { assetCacheControl, contentTypeOf, htmlCacheControl } from "alchemy/Website/assets";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** The file a Node target writes next to the assets. It is never an asset. */
export const SERVE_ENTRY_FILE = "serve-node.mjs";

/** Cache rule for a file with no content hash: the CDN revalidates it every time. */
const UNHASHED_CACHE_CONTROL = "public,max-age=0,must-revalidate";

/**
 * Whether a path in a build's client directory carries a content hash, by the
 * layouts frameworks write: inside a build-asset directory, with a name ending in
 * a hash-shaped segment (`index-DiwrgTda.js`, `entry.a1b2c3d4.css`). A hash follows
 * a separator, except for a Nuxt chunk, which is named after its hash alone. Rollup's
 * are eight base64url characters, so they can hold `-` and `_`. A name that only
 * looks like one (`assets/TeamPhoto.png`, `assets/site-main-2.css`,
 * `assets/photo-20240115.jpg`) isn't one, and a file that is wrongly left out is only
 * revalidated, where one wrongly matched would be cached for a year.
 *
 * Keep in step with `HASHED_ASSET_SOURCE` in `frontend-frameworks`'
 * `core/NodeServe.ts`, which this package can't import.
 */
export const isHashedAsset = (file: string): boolean => {
  if (/(?:^|\/)(?:_app\/immutable|_next\/static)\//.test(file)) return true;
  if (!/(?:^|\/)(?:assets|_astro|_nuxt|_build)\//.test(file)) return false;
  const name = file.slice(file.lastIndexOf("/") + 1);
  const stem = name.replace(/\.[A-Za-z0-9]+$/, "");
  const hashLike = (hash: string) => /[A-Za-z]/.test(hash) && /[0-9]|.[A-Z]/.test(hash);
  const plain = /[-.]([A-Za-z0-9]{8,})$/.exec(stem)?.[1];
  if (plain !== undefined) return hashLike(plain);
  const rollup = /[-.]([A-Za-z0-9_-]{8})$/.exec(stem)?.[1];
  if (rollup !== undefined) return /.[A-Z]/.test(rollup);
  return /(?:^|\/)_nuxt\/[^/]+$/.test(file) && /^[A-Za-z0-9_-]{8,}$/.test(stem) && hashLike(stem);
};

const isHtml = (file: string) => /\.html?$/i.test(file);

/** `Cache-Control` of an uploaded file. */
export const cacheControlFor = (file: string): string =>
  isHtml(file)
    ? htmlCacheControl
    : isHashedAsset(file)
      ? assetCacheControl
      : UNHASHED_CACHE_CONTROL;

/** `Content-Type` of an uploaded file; core's table, plus what static sites also ship. */
export const contentTypeFor = (file: string): string => {
  const known: Record<string, string> = {
    avif: "image/avif",
    pdf: "application/pdf",
    webmanifest: "application/manifest+json",
    xml: "application/xml",
  };
  return known[file.slice(file.lastIndexOf(".") + 1).toLowerCase()] ?? contentTypeOf(file);
};

/** `dir/` or `/dir` as `dir`; empty for the root. */
export const normalizePrefix = (prefix: string | undefined): string =>
  (prefix ?? "").replace(/^\/+|\/+$/g, "");

/**
 * Every object key a file is stored under. A bucket has no directory index and the
 * CDN no rewrite, so a page also gets a copy at the URLs frameworks link to:
 * `about/index.html` at `about` and `about/`, and with `drop-trailing-slash`,
 * `about.html` at `about`. The root has no key of its own.
 */
export const objectKeysOf = (
  relative: string,
  options: {
    prefix?: string | undefined;
    htmlHandling?: "none" | "drop-trailing-slash" | undefined;
  },
): string[] => {
  const prefix = normalizePrefix(options.prefix);
  const key = prefix === "" ? relative : `${prefix}/${relative}`;
  if (key.endsWith("/index.html")) {
    const directory = key.slice(0, -"/index.html".length);
    return [key, directory, `${directory}/`];
  }
  return options.htmlHandling === "drop-trailing-slash" && key.endsWith(".html")
    ? [key, key.slice(0, -".html".length)]
    : [key];
};

/** The URL paths a CDN could have cached a file's response under. */
export const urlPathsOf = (
  relative: string,
  options: {
    prefix?: string | undefined;
    htmlHandling?: "none" | "drop-trailing-slash" | undefined;
  },
): string[] => {
  const prefix = normalizePrefix(options.prefix);
  const paths = objectKeysOf(relative, options).map((key) => `/${key}`);
  return relative === "index.html" ? [prefix === "" ? "/" : `/${prefix}/`, ...paths] : paths;
};

/** Every file under a directory, relative to it with `/`, sorted. */
export const walkFiles = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(root))) return [] as string[];
  const names = yield* fs.readDirectory(root, { recursive: true });
  const files = yield* Effect.forEach(
    names,
    (name) =>
      Effect.gen(function* () {
        const stat = yield* fs.stat(path.join(root, name));
        return stat.type === "File" ? name.replaceAll("\\", "/") : undefined;
      }),
    { concurrency: 32 },
  );
  return files
    .filter((name): name is string => name !== undefined)
    .sort((left, right) => left.localeCompare(right));
});

/**
 * A source directory, relative to the process's INITIAL cwd: build attributes are
 * stored that way, and a sibling framework build may chdir this process.
 */
export const resolveSource = Effect.fn(function* (source: string) {
  const path = yield* Path.Path;
  return path.resolve(initialCwd, source);
});

export const md5 = (body: Uint8Array) =>
  Effect.sync(() => createHash("md5").update(body).digest("hex"));

/**
 * What a deploy may have to purge: the unhashed files of a client directory by URL
 * path, each with the hash of its content. A hashed file gets a new URL instead.
 */
export const purgeableFiles = Effect.fn(function* (
  root: string,
  options: {
    prefix?: string | undefined;
    htmlHandling?: "none" | "drop-trailing-slash" | undefined;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = (yield* walkFiles(root)).filter(
    (file) => file !== SERVE_ENTRY_FILE && !isHashedAsset(file),
  );
  const entries = yield* Effect.forEach(
    files,
    (file) =>
      fs.readFile(path.join(root, file)).pipe(
        Effect.flatMap(md5),
        Effect.map((hash) => urlPathsOf(file, options).map((url) => [url, hash] as const)),
      ),
    { concurrency: 32 },
  );
  return Object.fromEntries(entries.flat());
});
