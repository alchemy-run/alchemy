import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * Refresh expiring credentials this long before they actually expire so that
 * in-flight requests never race the expiry deadline.
 */
export const CREDENTIAL_REFRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Compute the moment a cached credential should be re-resolved: the refresh
 * window before `expiresAt`, clamped so an already-stale credential still
 * caches until its actual expiry instead of re-resolving on every call.
 * Pass `undefined` for credentials that never expire.
 */
export const refreshAtFor = (
  expiresAt: number | undefined,
  now: number,
): number => {
  if (expiresAt === undefined) return Number.POSITIVE_INFINITY;
  return expiresAt <= now + CREDENTIAL_REFRESH_WINDOW_MS
    ? expiresAt
    : expiresAt - CREDENTIAL_REFRESH_WINDOW_MS;
};

/**
 * Memoize a credentials-resolution effect until shortly before the resolved
 * credentials expire.
 *
 * The distilled HTTP clients resolve the `Credentials` service's effect on
 * *every* request (`yield* config.credentials`), which is what allows OAuth
 * tokens to rotate mid-process — a dev session can outlive the ~1h access
 * token, so caching the first resolution forever leaves the process making
 * API calls with a dead token until restart. At the same time, resolution
 * acquires a cross-process file lock (`auth.read`), so resolving fresh on
 * every request would stampede that lock under high concurrency (e.g.
 * `unsafe nuke`).
 *
 * This cache serves both needs: callers get the cached credentials while
 * they are still valid, the resolver re-runs (refreshing + persisting the
 * token) once the refresh window is reached, and a mutex makes resolution
 * single-flight so concurrent callers share one lock acquisition.
 *
 * `expiresAt` extracts the credential's absolute expiry in epoch ms, or
 * `undefined` for credentials that never expire (cached forever).
 */
export const cacheUntilExpiry = <A, E>(
  resolve: Effect.Effect<A, E>,
  expiresAt: (credentials: A) => number | undefined,
  now: () => number = () => Date.now(),
): Effect.Effect<A, E> => {
  const mutex = Semaphore.makeUnsafe(1);
  let cached: { credentials: A; refreshAt: number } | undefined;
  return Semaphore.withPermits(
    mutex,
    1,
  )(
    Effect.suspend(() => {
      if (cached && now() < cached.refreshAt) {
        return Effect.succeed(cached.credentials);
      }
      return Effect.map(resolve, (credentials) => {
        cached = {
          credentials,
          refreshAt: refreshAtFor(expiresAt(credentials), now()),
        };
        return credentials;
      });
    }),
  );
};
