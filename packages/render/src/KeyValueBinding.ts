import type { Url } from "@alchemy.run/redis";
import { UrlMissing as RedisUrlMissing } from "@alchemy.run/redis";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import { CurrentRuntimeContext, sanitizeKey, type RuntimeContext } from "alchemy/RuntimeContext";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { KeyValue } from "./KeyValue.ts";
import type { Redis } from "./Redis.ts";
import { isRenderHost } from "./RenderBindings.ts";

/**
 * Shared scaffolding for Render Key Value and Redis bindings.
 *
 * NOT exported from `index.ts`.
 */
export const REDIS_URL_ENV = "REDIS_URL";

export const keyValueEnvKeys = (instance: Pick<KeyValue | Redis, "LogicalId">) => {
  const id = instance.LogicalId.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return {
    internal: `RENDER_KV_${id}_INTERNAL`,
    external: `RENDER_KV_${id}_EXTERNAL`,
  } as const;
};

const readConfigUrl = (key: string): Effect.Effect<string | undefined> =>
  Config.Redacted(key).pipe(
    Config.option,
    Effect.orDie,
    Effect.map(Option.getOrUndefined),
    Effect.map((v) => (v !== undefined ? Redacted.value(v) : undefined)),
  );

const runtimeOutput = <A>(
  key: string,
  output: Output.Output<A> | A,
): Effect.Effect<A, never, RuntimeContext> =>
  Output.isOutput(output)
    ? output.bind(key).pipe(Effect.flatMap((effect) => effect))
    : Effect.succeed(output);

const readUrlCandidate = (
  key: string,
  output: Output.Output<Redacted.Redacted<string>>,
): Effect.Effect<string | undefined, never, RuntimeContext> =>
  Effect.gen(function* () {
    const rt = yield* CurrentRuntimeContext;
    if (rt) {
      const stored = yield* rt.get<string | Redacted.Redacted<string>>(sanitizeKey(key));
      if (Redacted.isRedacted(stored) && Redacted.value(stored).length > 0) {
        return Redacted.value(stored);
      }
      if (typeof stored === "string" && stored.length > 0) {
        return stored;
      }
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const resolved = yield* runtimeOutput(key, output);
        if (Redacted.isRedacted(resolved) && Redacted.value(resolved).length > 0) {
          return Redacted.value(resolved);
        }
      }
    }
    return yield* readConfigUrl(key);
  });

export const makeKeyValueBinding = <Client>(options: {
  readonly makeClient: (url: Url) => Client;
}) =>
  Effect.succeed(
    Effect.fn(function* (instance: KeyValue | Redis) {
      const keys = keyValueEnvKeys(instance);
      const resourceName = instance.LogicalId;
      let preferExternal = false;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isRenderHost(host)) {
          yield* host.bind`${instance}`({
            env: {
              [keys.internal]: instance.connectionInfo.internalConnectionString,
              [keys.external]: instance.connectionInfo.externalConnectionString,
              [REDIS_URL_ENV]: instance.connectionInfo.internalConnectionString,
            },
          });
        } else {
          preferExternal = true;
          const rt = yield* CurrentRuntimeContext;
          if (rt) {
            yield* rt.set(
              sanitizeKey(keys.external),
              instance.connectionInfo.externalConnectionString,
            );
          }
        }
      }

      const url: Url = Effect.gen(function* () {
        const primary = preferExternal
          ? yield* readUrlCandidate(keys.external, instance.connectionInfo.externalConnectionString)
          : yield* readUrlCandidate(
              keys.internal,
              instance.connectionInfo.internalConnectionString,
            );
        if (primary && primary.length > 0) return primary;

        const secondary = preferExternal
          ? yield* readUrlCandidate(keys.internal, instance.connectionInfo.internalConnectionString)
          : yield* readUrlCandidate(
              keys.external,
              instance.connectionInfo.externalConnectionString,
            );
        if (secondary && secondary.length > 0) return secondary;

        const fallback = yield* readConfigUrl(REDIS_URL_ENV);
        if (fallback && fallback.length > 0) return fallback;

        return yield* new RedisUrlMissing({ resourceName });
      });

      return options.makeClient(url);
    }),
  );
