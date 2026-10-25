import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Route helpers for the Function fixtures of the ARM runtime-action binding
 * suites (start, stop, restart, pause, failover, …).
 */

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
export const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result: result ?? null })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/** Answer `{ accepted: true }` once Azure accepts the action. */
export const accepted = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  respond(Effect.as(effect, { accepted: true }));
