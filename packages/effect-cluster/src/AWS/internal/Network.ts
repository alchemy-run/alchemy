/**
 * Resolve a {@link NetworkInput} to the network the cluster's resources
 * take.
 *
 * @internal
 */
import * as Effect from "effect/Effect";
import type { Network, NetworkInput } from "../Network.ts";

export const resolveNetwork = <N extends Network, E, R>(
  input: NetworkInput<N, E, R>,
): Effect.Effect<N, E, R> => (Effect.isEffect(input) ? input : Effect.succeed(input));
