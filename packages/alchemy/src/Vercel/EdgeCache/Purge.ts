/**
 * Edge-cache purge runtime actions — plain Effects, not resources.
 *
 * Vercel's edge cache is purged per project, either by cache tag or by
 * source image. Purging is a traffic operation over already-deployed
 * content, so it is modeled like promote/rollback: an action you run, not
 * state the engine converges.
 *
 * Two flavors exist per key:
 * - **invalidate** — marks entries stale; they are revalidated in the
 *   background on the next request (stale content may be served once while
 *   revalidating). Safe default.
 * - **dangerouslyDelete** — drops entries outright; the next request blocks
 *   on the origin. One tag or source image can map to many paths, so a
 *   delete can stampede the origin. Prefer invalidate.
 */
import * as edgeCache from "@distilled.cloud/vercel/edge_cache";
import * as Effect from "effect/Effect";
import { VercelEnvironment } from "../VercelEnvironment.ts";

/**
 * The project a purge targets — a resource carrying `projectId` (e.g. a
 * `Vercel.Project`'s or `Vercel.Function`'s attributes) or a plain project
 * id/name.
 */
export type PurgeTarget = { projectId: string } | string;

const resolveProjectId = (target: PurgeTarget) =>
  typeof target === "string" ? target : target.projectId;

export interface InvalidateEdgeCacheOptions {
  /**
   * The deployment target whose cache to purge.
   *
   * @default "production"
   */
  target?: string;
}

/**
 * Invalidate edge-cache entries by cache tag: entries are marked stale and
 * revalidated in the background on the next request.
 *
 * ```typescript
 * yield* Vercel.invalidateEdgeCacheByTags(fn, ["products", "pricing"]);
 * ```
 */
export const invalidateEdgeCacheByTags = (
  target: PurgeTarget,
  tags: string | ReadonlyArray<string>,
  options?: InvalidateEdgeCacheOptions,
) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    yield* edgeCache.invalidateByTags({
      projectIdOrName: resolveProjectId(target),
      tags: typeof tags === "string" ? tags : [...tags],
      ...(options?.target !== undefined ? { target: options.target } : {}),
      teamId,
    });
  });

/**
 * Invalidate edge-cache entries by source image (ISR/image-optimization
 * cache): entries are marked stale and revalidated in the background.
 *
 * ```typescript
 * yield* Vercel.invalidateEdgeCacheBySrcImages(fn, [
 *   "https://acme.com/hero.png",
 * ]);
 * ```
 */
export const invalidateEdgeCacheBySrcImages = (
  target: PurgeTarget,
  srcImages: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    yield* edgeCache.invalidateBySrcImages({
      projectIdOrName: resolveProjectId(target),
      srcImages: [...srcImages],
      teamId,
    });
  });

export interface DeleteEdgeCacheOptions extends InvalidateEdgeCacheOptions {
  /**
   * Spread foreground revalidation over this many seconds to soften the
   * origin stampede a hard delete can cause.
   */
  revalidationDeadlineSeconds?: number;
}

/**
 * Hard-delete edge-cache entries by cache tag. The next request for each
 * affected path blocks on the origin — one tag can map to many paths, so
 * this can stampede the origin. Prefer {@link invalidateEdgeCacheByTags}.
 *
 * ```typescript
 * yield* Vercel.dangerouslyDeleteEdgeCacheByTags(fn, "catalog", {
 *   revalidationDeadlineSeconds: 60,
 * });
 * ```
 */
export const dangerouslyDeleteEdgeCacheByTags = (
  target: PurgeTarget,
  tags: string | ReadonlyArray<string>,
  options?: DeleteEdgeCacheOptions,
) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    yield* edgeCache.dangerouslyDeleteByTags({
      projectIdOrName: resolveProjectId(target),
      tags: typeof tags === "string" ? tags : [...tags],
      ...(options?.target !== undefined ? { target: options.target } : {}),
      ...(options?.revalidationDeadlineSeconds !== undefined
        ? { revalidationDeadlineSeconds: options.revalidationDeadlineSeconds }
        : {}),
      teamId,
    });
  });

/**
 * Hard-delete edge-cache entries by source image. The affected cache
 * entries are revalidated in the foreground on the next request. Prefer
 * {@link invalidateEdgeCacheBySrcImages}.
 */
export const dangerouslyDeleteEdgeCacheBySrcImages = (
  target: PurgeTarget,
  srcImages: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    yield* edgeCache.dangerouslyDeleteBySrcImages({
      projectIdOrName: resolveProjectId(target),
      srcImages: [...srcImages],
      teamId,
    });
  });
