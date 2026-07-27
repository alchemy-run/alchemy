import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { AlchemyContext } from "alchemy/AlchemyContext";
import packageJson from "../../package.json" with { type: "json" };

const NPM_DIST_TAGS_URL =
  "https://registry.npmjs.org/-/package/alchemy/dist-tags";

const CACHE_FILE = "version-check.json";
const CACHE_TTL_MILLIS = Duration.toMillis(Duration.days(1));
// npm's dist-tags endpoint is CDN-backed and typically answers in ~100ms;
// the sync budget only needs to absorb a slow handshake, not a dead network.
const SYNC_FETCH_TIMEOUT = Duration.seconds(3);
const BACKGROUND_FETCH_TIMEOUT = Duration.seconds(15);

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

const readCache = (cachePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(cachePath);
    const parsed = yield* Effect.try(
      () => JSON.parse(raw) as VersionCheckCache | null | undefined,
    );
    if (typeof parsed?.checkedAt !== "number") return undefined;
    if (parsed.distTags !== undefined && typeof parsed.distTags !== "object") {
      return undefined;
    }
    return parsed;
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));

const writeCache = (cachePath: string, distTags?: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const checkedAt = yield* Clock.currentTimeMillis;
    const cache: VersionCheckCache = { checkedAt, distTags };
    yield* fs.writeFileString(cachePath, JSON.stringify(cache));
  }).pipe(Effect.catch(() => Effect.void));

const fetchDistTags = (timeout: Duration.Duration) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.get(NPM_DIST_TAGS_URL);
    const distTags = (yield* response.json) as Record<string, string>;
    if (typeof distTags !== "object" || distTags === null) {
      return yield* Effect.fail(new Error("malformed dist-tags response"));
    }
    return distTags;
  }).pipe(Effect.timeout(timeout));

/**
 * Warn if a newer `alchemy` version is published on the dist-tag matching
 * the current channel. Runs to completion before any interactive prompts so
 * the warning never interleaves with prompt rendering, and is bounded so it
 * can never stall the CLI for long:
 *
 * - the registry's dist-tags are cached in `.alchemy/version-check.json`
 *   for a day, so at most one run per day touches the network at all
 * - the blocking fetch times out after a few seconds; on failure the
 *   attempt itself is cached (so a dead network costs at most one timeout
 *   per day, not one per run) and a longer-budget background fetch is
 *   forked that silently refreshes the cache for subsequent runs — it
 *   never logs, so it cannot interleave with prompts
 * - every failure (offline, registry hiccup, corrupt cache) is swallowed
 */
export const checkLatestVersion = Effect.gen(function* () {
  const path = yield* Path.Path;
  const { dotAlchemy } = yield* AlchemyContext;
  const cachePath = path.join(dotAlchemy, CACHE_FILE);
  const now = yield* Clock.currentTimeMillis;

  const cached = yield* readCache(cachePath);
  let distTags = cached?.distTags;
  if (cached === undefined || now - cached.checkedAt > CACHE_TTL_MILLIS) {
    const fetched = yield* Effect.result(fetchDistTags(SYNC_FETCH_TIMEOUT));
    if (Result.isSuccess(fetched)) {
      distTags = fetched.success;
      yield* writeCache(cachePath, distTags);
    } else {
      // Record the failed attempt so the next runs skip the blocking fetch
      // for a full TTL window, then retry in the background with a longer
      // budget: if it lands before the CLI exits, subsequent runs get the
      // fresh dist-tags for free. It never logs, so it can't interleave
      // with interactive prompts.
      yield* writeCache(cachePath, distTags);
      yield* fetchDistTags(BACKGROUND_FETCH_TIMEOUT).pipe(
        Effect.flatMap((distTags) => writeCache(cachePath, distTags)),
        Effect.catch(() => Effect.void),
        Effect.forkScoped,
      );
      if (distTags === undefined) return;
    }
  }
  if (distTags === undefined) return;

  const current = packageJson.version;
  const latest = pickDistTag(current, distTags);
  if (typeof latest !== "string" || latest === current) return;
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
