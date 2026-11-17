import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ReadSecret, SecretValueMissing, type ReadSecretClient } from "./ReadSecret.ts";
import type { Secret } from "./Secret.ts";

const envKey = (secret: Secret) =>
  `DO_SECRET_${secret.LogicalId}`.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_");

/**
 * `ReadSecret` for any host: the values travel as one secret through the
 * host's runtime context.
 *
 * @layer
 * @product Security
 * @provides DigitalOcean.Security.ReadSecret
 */
export const ReadSecretHttp = Layer.succeed(
  ReadSecret,
  Effect.fn(function* (secret: Secret) {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const runtime = yield* CurrentRuntimeContext;
      if (runtime !== undefined) yield* runtime.set(envKey(secret), secret.values);
    }
    // Read in the construction phase, where the host's runtime context is
    // present; request handlers close over the value.
    const runtime = globalThis.__ALCHEMY_RUNTIME__ ? yield* CurrentRuntimeContext : undefined;
    const bound =
      runtime === undefined
        ? undefined
        : yield* runtime.get<Redacted.Redacted<Record<string, string>>>(envKey(secret));
    const missing = (key?: string) => new SecretValueMissing({ secret: secret.LogicalId, key });
    const values = bound === undefined ? Effect.fail(missing()) : Effect.succeed(bound);
    return {
      values,
      get: (key) =>
        Effect.flatMap(values, (all) => {
          const value = Redacted.value(all)[key];
          return value === undefined
            ? Effect.fail(missing(key))
            : Effect.succeed(Redacted.make(value));
        }),
    } satisfies ReadSecretClient;
  }),
);
