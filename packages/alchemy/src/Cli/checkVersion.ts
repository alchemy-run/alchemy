import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { AlchemyContext } from "alchemy/AlchemyContext";
import packageJson from "../../package.json" with { type: "json" };

const NPM_DIST_TAGS_URL =
  "https://registry.npmjs.org/-/package/alchemy/dist-tags";

const CACHE_FILE = "version-check.json";
const CACHE_TTL_MILLIS = Duration.toMillis(Duration.days(1));
const FETCH_TIMEOUT = Duration.seconds(3);

interface VersionCheckCache {
  checkedAt: number;
  distTags: Record<string, string>;
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
    const parsed = yield* Effect.try(() => JSON.parse(raw) as unknown);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as VersionCheckCache).checkedAt !== "number" ||
      typeof (parsed as VersionCheckCache).distTags !== "object" ||
      (parsed as VersionCheckCache).distTags === null
    ) {
      return undefined;
    }
    return parsed as VersionCheckCache;
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));

const fetchDistTags = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const response = yield* http.get(NPM_DIST_TAGS_URL);
  const distTags = (yield* response.json) as Record<string, string>;
  if (typeof distTags !== "object" || distTags === null) return undefined;
  return distTags;
}).pipe(Effect.timeout(FETCH_TIMEOUT));

/**
 * Warn if a newer `alchemy` version is published on the dist-tag matching
 * the current channel. Runs synchronously (before any interactive prompts)
 * so the warning never interleaves with prompt rendering. The registry's
 * dist-tags are cached in `.alchemy/version-check.json` for a day so the
 * network round-trip only happens once daily. Best-effort: any failure
 * (offline, registry hiccup, slow response, unreadable cache) is swallowed
 * silently and the fetch times out after a few seconds.
 */
export const checkLatestVersion = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { dotAlchemy } = yield* AlchemyContext;
  const cachePath = path.join(dotAlchemy, CACHE_FILE);
  const now = yield* Clock.currentTimeMillis;

  const cached = yield* readCache(cachePath);
  let distTags = cached?.distTags;
  if (cached === undefined || now - cached.checkedAt > CACHE_TTL_MILLIS) {
    distTags = yield* fetchDistTags;
    if (distTags === undefined) return;
    const cache: VersionCheckCache = { checkedAt: now, distTags };
    yield* fs
      .writeFileString(cachePath, JSON.stringify(cache))
      .pipe(Effect.catch(() => Effect.void));
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
