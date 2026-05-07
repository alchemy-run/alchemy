import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

import packageJson from "../../package.json" with { type: "json" };

const NPM_DIST_TAGS_URL =
  "https://registry.npmjs.org/-/package/alchemy/dist-tags";

/**
 * Compare two semver-ish version strings. Returns:
 *   <0 if a < b, 0 if equal, >0 if a > b.
 * Pre-release versions (e.g. `2.0.0-beta.33`) sort below the same release
 * core (`2.0.0`), per semver §11.
 */
const compareVersions = (a: string, b: string): number => {
  const [aCore, aPre] = a.split("-", 2);
  const [bCore, bPre] = b.split("-", 2);
  const aParts = aCore.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const bParts = bCore.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // Same core. A pre-release is lower precedence than no pre-release.
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  if (aPre && bPre) {
    const aIds = aPre.split(".");
    const bIds = bPre.split(".");
    const idLen = Math.max(aIds.length, bIds.length);
    for (let i = 0; i < idLen; i++) {
      const ai = aIds[i];
      const bi = bIds[i];
      if (ai === undefined) return -1;
      if (bi === undefined) return 1;
      const an = Number.parseInt(ai, 10);
      const bn = Number.parseInt(bi, 10);
      const aNumeric = Number.isFinite(an) && String(an) === ai;
      const bNumeric = Number.isFinite(bn) && String(bn) === bi;
      if (aNumeric && bNumeric) {
        if (an !== bn) return an - bn;
      } else if (aNumeric) {
        return -1;
      } else if (bNumeric) {
        return 1;
      } else if (ai !== bi) {
        return ai < bi ? -1 : 1;
      }
    }
  }
  return 0;
};

/**
 * Pick the dist-tag that should be compared against `current`.
 *
 * For pre-release versions like `2.0.0-beta.33`, npm's `latest` tag points
 * at the most recent stable release (e.g. `0.93.7`), which is *older* than
 * the current beta — so naive `latest` comparisons would never warn beta
 * users about a newer beta. Match the prerelease identifier to a dist-tag
 * (`beta`, `next`, etc.), falling back through `next` -> `latest`.
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

/**
 * Fetch the latest published `alchemy` version on the dist-tag matching
 * the current channel and log a warning if it's newer than the bundled
 * version. Best-effort: any failure (offline, registry hiccup, slow
 * response) is swallowed silently.
 */
export const checkLatestVersion = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const response = yield* http.get(NPM_DIST_TAGS_URL);
  const distTags = (yield* response.json) as Record<string, string>;
  if (typeof distTags !== "object" || distTags === null) return;
  const current = packageJson.version;
  const latest = pickDistTag(current, distTags);
  if (typeof latest !== "string" || compareVersions(current, latest) >= 0) {
    return;
  }
  yield* Effect.logWarning(
    `A new version of alchemy is available: ${current} -> ${latest}. ` +
      "Run `npm install -g alchemy@latest` (or your package manager equivalent) to upgrade.",
  );
}).pipe(
  Effect.timeout(Duration.seconds(5)),
  Effect.catch(() => Effect.void),
);

// Exported for tests.
export const _internal = { compareVersions, pickDistTag };
