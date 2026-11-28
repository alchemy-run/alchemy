import * as RenderSdk from "@distilled.cloud/render";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { OwnerId } from "../Credentials.ts";
import { RenderOwnerResolutionError } from "../Errors.ts";

/** Catch only typed 404 `NotFound` errors and return `undefined`. */
export const ignoreNotFound = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchIf(
      (e): e is Extract<E, { readonly _tag: "NotFound" }> =>
        typeof e === "object" && e !== null && (e as { _tag?: unknown })._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  );

/** Delete helper treating `NotFound` as already deleted. */
export const deleteIdempotent = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  ignoreNotFound(effect).pipe(Effect.asVoid);

/**
 * Walk cursor-paginated Render list responses (`{ cursor?: string }[]`) until a
 * page returns empty or the cursor stops advancing.
 */
export const paginateCursorList = <Row extends { readonly cursor?: string }, Item, E, R>(
  fetchPage: (cursor: string | undefined) => Effect.Effect<ReadonlyArray<Row>, E, R>,
  extract: (row: Row) => Item | undefined,
): Effect.Effect<Item[], E, R> =>
  Effect.gen(function* () {
    const items: Item[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();

    while (true) {
      const page = yield* fetchPage(cursor);
      if (!Array.isArray(page) || page.length === 0) {
        break;
      }
      for (const row of page) {
        const item = extract(row);
        if (item !== undefined) {
          items.push(item);
        }
      }
      const nextCursor = page.at(-1)?.cursor;
      if (!nextCursor || nextCursor === cursor || seenCursors.has(nextCursor)) {
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return items;
  });

export const resolveOwnerId = (override?: string) =>
  Effect.gen(function* () {
    if (override && override.trim().length > 0) {
      return override.trim();
    }

    const ownerServiceOpt = yield* Effect.serviceOption(OwnerId);
    if (Option.isSome(ownerServiceOpt)) {
      const fromService = yield* ownerServiceOpt.value;
      if (fromService && fromService.trim().length > 0) {
        return fromService.trim();
      }
    }

    const owners = yield* RenderSdk.listOwners({ limit: 20 });
    const resolved = owners.flatMap((row) => (row.owner ? [row.owner] : []));
    if (resolved.length === 1) {
      return resolved[0].id;
    }
    if (resolved.length === 0) {
      return yield* new RenderOwnerResolutionError({
        ownerCount: 0,
        message:
          "No Render owners found for the configured API key. Set ownerId explicitly or configure RENDER_OWNER_ID.",
      });
    }
    return yield* new RenderOwnerResolutionError({
      ownerCount: resolved.length,
      message:
        `Multiple Render owners found (${resolved.map((o) => `${o.name}:${o.id}`).join(", ")}). ` +
        "Set ownerId on the resource, provide Render.ownerId(...), or configure ownerId in your Alchemy profile.",
    });
  });

/**
 * Move a Render resource between project environments (detaching from `currentEnvId`
 * and attaching to `desiredEnvId`) when the environment ID changed.
 */
export const syncResourceEnvironment = (
  resourceId: string,
  currentEnvId: string | undefined,
  desiredEnvId: string | undefined,
) =>
  Effect.gen(function* () {
    if (currentEnvId === desiredEnvId) {
      return;
    }
    if (currentEnvId) {
      yield* RenderSdk.removeResourcesFromEnvironment({
        environmentId: currentEnvId,
        resourceIds: [resourceId],
      }).pipe(
        Effect.catchIf(
          (e) => e._tag === "NotFound" || e._tag === "BadRequest",
          () => Effect.void,
        ),
      );
    }
    if (desiredEnvId) {
      yield* RenderSdk.addResourcesToEnvironment({
        environmentId: desiredEnvId,
        resourceIds: [resourceId],
      });
    }
  });
