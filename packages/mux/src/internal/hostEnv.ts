import type * as Output from "alchemy/Output";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";

/**
 * Host env key for one value of a bound Mux resource. Hex-encoding the FQN
 * keeps the key a valid env var name and distinct for every resource.
 */
export const hostEnvKey = (fqn: string, field: string) =>
  `MUX_${Array.from(fqn, (c) => c.codePointAt(0)!.toString(16)).join("_")}_${field}`;

/**
 * Carries `values` to the host through its runtime context: stored at
 * deploy (a `Redacted` output stays a secret), read back when the host
 * runs. Returns the values read at runtime, or `undefined` outside a host
 * or at deploy.
 */
export const bindHostEnv = Effect.fn(function* <K extends string>(
  fqn: string,
  values: Record<K, Output.Output>,
) {
  const runtime = yield* CurrentRuntimeContext;
  if (runtime === undefined) return undefined;
  const keys = Object.keys(values) as K[];
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    for (const field of keys) yield* runtime.set(hostEnvKey(fqn, field), values[field]);
    return undefined;
  }
  const read: Partial<Record<K, unknown>> = {};
  for (const field of keys) read[field] = yield* runtime.get(hostEnvKey(fqn, field));
  return read;
});
