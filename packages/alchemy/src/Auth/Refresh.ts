import * as Effect from "effect/Effect";

/**
 * Refresh credentials and save them in one step an interrupt can't split.
 *
 * Most token endpoints rotate the refresh token: once `request` is sent, the
 * stored token is spent. An interrupt (Ctrl-C, SIGTERM, a cancelled parent)
 * between the response and the save would leave the profile holding a dead
 * token, so every later command would need a browser login (#2843). Here an
 * interrupt waits until `save` has run.
 *
 * `request` must end on its own (give it a timeout), or an interrupt waits on
 * it too.
 *
 * @example
 * ```ts
 * const fresh = yield* refreshAndSave(client.refresh(creds), (fresh) =>
 *   updateConfig?.(toConfig(fresh)) ?? Effect.void,
 * );
 * ```
 */
export const refreshAndSave = <A, E, R, E2, R2>(
  request: Effect.Effect<A, E, R>,
  save: (fresh: A) => Effect.Effect<unknown, E2, R2>,
): Effect.Effect<A, E | E2, R | R2> => Effect.uninterruptible(Effect.tap(request, save));
