import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { AlchemyContext } from "alchemy/AlchemyContext";
import packageJson from "../../package.json" with { type: "json" };

const NPM_DIST_TAGS_URL =
  "https://registry.npmjs.org/-/package/alchemy/dist-tags";

const CACHE_FILE = "version-check.json";
const CACHE_TTL_MILLIS = Duration.toMillis(Duration.days(1));
// npm's dist-tags endpoint is CDN-backed and typically answers in ~100ms;
// the sync budget only needs to absorb a slow handshake, not a dead network.
const SYNC_WAIT = Duration.seconds(3);

interface VersionCheckCache {
  checkedAt: number;
  /** Absent when the last check attempt failed (offline, timeout, …). */
  distTags?: Record<string, string>;
}

/**
 * Pick the dist-tag matching the current channel. For pre-release versions
 * like `2.0.0-beta.33`, npm's `latest` tag points at the most recent stable
 * release — not the newest beta — so we match the prerelease identifier
 * (`beta`, `next`, etc.), falling back through `next` → `latest`.
 */
const pickDistTag = (
  current: string,
  distTags: Record<string, string>,
): string | undefined => {
  const pre = current.split("-", 2)[1];
  if (pre) {
    const id = pre.split(".")[0];
    if (id && distTags[id]) return distTags[id];
    if (distTags.next) return distTags.next;
  }
  return distTags.latest;
};

const readCache = Effect.fn(
  function* (cachePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(cachePath);
    const parsed = yield* Effect.try(
      () => JSON.parse(raw) as VersionCheckCache | null | undefined,
    );
    return typeof parsed?.checkedAt === "number" ? parsed : undefined;
  },
  Effect.catch(() => Effect.succeed(undefined)),
);

const writeCache = Effect.fn(
  function* (cachePath: string, distTags?: Record<string, string>) {
    const fs = yield* FileSystem.FileSystem;
    const checkedAt = yield* Clock.currentTimeMillis;
    const cache: VersionCheckCache = { checkedAt, distTags };
    yield* fs.writeFileString(cachePath, JSON.stringify(cache));
  },
  Effect.catch(() => Effect.void),
);

const fetchDistTags = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const response = yield* http.get(NPM_DIST_TAGS_URL);
  const distTags = (yield* response.json) as Record<string, string> | null;
  if (typeof distTags !== "object" || distTags === null) {
    return yield* Effect.fail(new Error("malformed dist-tags response"));
  }
  return distTags;
});

/**
 * Refresh the dist-tags cache with a single request. The fetch is forked so
 * it outlives the sync wait: we give it {@link SYNC_WAIT} to land inline,
 * and if it's still in flight the same request keeps going in the
 * background, writing the cache when it completes. The background path
 * never logs, so it can't interleave with prompts.
 */
const refreshDistTags = Effect.fn(function* (cachePath: string) {
  const fetch = yield* fetchDistTags.pipe(
    // The fiber owns all cache writes, whenever it completes — even after
    // the sync wait below has given up on it. A failed attempt is cached
    // too (a bare checkedAt), so a dead network costs at most one blocking
    // wait per TTL window, not one per run.
    Effect.tap((distTags) => writeCache(cachePath, distTags)),
    Effect.tapError(() => writeCache(cachePath)),
    Effect.forkScoped,
  );
  return yield* Fiber.join(fetch).pipe(
    Effect.timeout(SYNC_WAIT),
    Effect.catch(() => Effect.succeed(undefined)),
  );
});

const refreshDistTagsWithClient = Effect.fn(function* (cachePath: string) {
  const FetchHttpClient = yield* Effect.promise(
    () => import("effect/unstable/http/FetchHttpClient"),
  );
  // Build in the CLI's outer scope so a request that exceeds SYNC_WAIT keeps
  // its client alive and can still populate the cache in the background.
  const context = yield* Layer.build(FetchHttpClient.layer);
  return yield* refreshDistTags(cachePath).pipe(Effect.provide(context));
});

/**
 * Warn if a newer `alchemy` version is published on the dist-tag matching
 * the current channel. Runs to completion before any interactive prompts so
 * the warning never interleaves with prompt rendering, and is bounded so it
 * can never stall the CLI: dist-tags are cached in
 * `.alchemy/version-check.json` for a day (failed attempts included), so at
 * most one run per day waits on the network, and only up to
 * {@link SYNC_WAIT}. Best-effort: every failure is swallowed silently.
 */
export const checkLatestVersion = Effect.gen(function* () {
  const path = yield* Path.Path;
  const { dotAlchemy } = yield* AlchemyContext;
  const cachePath = path.join(dotAlchemy, CACHE_FILE);
  const now = yield* Clock.currentTimeMillis;

  const cached = yield* readCache(cachePath);
  const distTags =
    cached !== undefined && now - cached.checkedAt <= CACHE_TTL_MILLIS
      ? cached.distTags
      : yield* refreshDistTagsWithClient(cachePath);
  if (distTags === undefined) return;

  const current = packageJson.version;
  const latest = pickDistTag(current, distTags);
  if (latest === undefined || latest === current) return;

  const installCmd =
    typeof process !== "undefined" && (process as any).versions?.bun
      ? `bun add alchemy@${latest}`
      : `pnpm add alchemy@${latest}`;
  // Print via the Console service, not Effect.logWarning: TelemetryLive
  // replaces the default stdout logger with an OTLP-only logger at this
  // stage of the program, so log output would never reach the terminal.
  const useColor = process.stderr.isTTY === true;
  const message =
    `alchemy ${latest} is available (you're on ${current}). ` +
    `Run \`${installCmd}\` to upgrade.`;
  yield* Console.warn(useColor ? `\x1b[33m${message}\x1b[0m` : message);
}).pipe(Effect.catch(() => Effect.void));

// Exported for tests.
export const _internal = { pickDistTag };
