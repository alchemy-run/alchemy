import { Random } from "alchemy/Random";
import type * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";

/**
 * A control plane's admin token: 32 random bytes. `Rivet.providers()`
 * registers the Random provider, so a Rivet Layer requires the Rivet
 * provider collection rather than `Provider<Random>` on its own.
 *
 * @internal
 */
export const adminToken = (id: string) =>
  Random(`${id}AdminToken`, { bytes: 32 }) as unknown as Effect.Effect<Random, never, Providers>;
