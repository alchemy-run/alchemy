import {
  DIGITALOCEAN_ACCESS_TOKEN_ENV,
  DIGITALOCEAN_API_KEY_ENV,
  DIGITALOCEAN_TOKEN_ENV,
} from "@alchemy.run/digitalocean";
import type { NotFound } from "@distilled.cloud/digitalocean";
import { isActionState, State } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const skipLive = ![
  DIGITALOCEAN_TOKEN_ENV,
  DIGITALOCEAN_ACCESS_TOKEN_ENV,
  DIGITALOCEAN_API_KEY_ENV,
].some((name) => process.env[name]);

/** A droplet takes minutes to create and destroy, so `--fast` skips it. */
export const skipSlow = skipLive || !!process.env.FAST;

export const isGone = <A, E, R>(read: Effect.Effect<A, E | NotFound, R>) =>
  read.pipe(
    Effect.as(false),
    Effect.catchTag("NotFound", () => Effect.succeed(true)),
  );

/**
 * Reproduces a crash after the cloud resource was created but before its
 * attributes were committed: the row goes back to `creating` without them.
 */
export const forgetAttributes = Effect.fn(function* (address: {
  readonly stack: string;
  readonly stage: string;
  readonly fqn: string;
}) {
  const state = yield* yield* State;
  const stored = yield* state.get(address);
  if (!stored || isActionState(stored) || stored.status !== "created") {
    return yield* Effect.die(new Error(`Expected a created row for ${address.fqn}`));
  }
  const { attr: _attr, ...creating } = stored;
  yield* state.set({ ...address, value: { ...creating, status: "creating" } });
});
