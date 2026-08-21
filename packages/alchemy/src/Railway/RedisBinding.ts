import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import type { Resource } from "../Resource.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { ServiceBinding } from "./MountVolume.ts";
import {
  REDIS_URL_ENV,
  RedisUrlMissing,
  redisCommand as sendRedisCommand,
  type Redis,
} from "./Redis.ts";

/**
 * Shared scaffolding for Railway Redis bindings.
 *
 * Each `{Op}Http.ts` is a thin `Layer.effect` over {@link makeRedisBinding}.
 * Deploy-time writes `REDIS_URL` onto the host Service as a Railway
 * reference (`${{RedisName.REDIS_URL}}`). Runtime commands use that URL
 * internally — callers never read `Config.redacted`.
 *
 * NOT exported from `index.ts`.
 */

const isRailwayHost = (
  value: unknown,
): value is Resource<string, any, any, ServiceBinding> =>
  typeof value === "object" &&
  value !== null &&
  (value as { Type?: string }).Type === "Railway.Service";

const asPlain = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) return value;
  if (Redacted.isRedacted(value)) return asPlain(Redacted.value(value));
  return undefined;
};

const resolveName = (redis: Redis): Effect.Effect<string> =>
  Effect.gen(function* () {
    const direct = asPlain(redis.name);
    if (direct !== undefined) return direct;
    const value = redis.name as unknown;
    if (Effect.isEffect(value)) {
      return asPlain(yield* value as Effect.Effect<unknown>) ?? "";
    }
    return "";
  });

const redisUrlFromEnv = Config.redacted(REDIS_URL_ENV).pipe(
  Effect.map((value) => Redacted.value(value)),
);

export const makeRedisBinding = <Client>(options: {
  makeClient: (
    url: Effect.Effect<string, RedisUrlMissing, RuntimeContext>,
  ) => Client;
}) =>
  Effect.succeed(
    Effect.fn(function* (redis: Redis) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isRailwayHost(host)) {
          const name = yield* resolveName(redis);
          if (name.length > 0) {
            yield* host.bind`${redis}`({
              env: {
                [REDIS_URL_ENV]: `\${{${name}.${REDIS_URL_ENV}}}`,
              },
            });
          }
        }
      }

      const url = redisUrlFromEnv.pipe(
        Effect.mapError(
          () =>
            new RedisUrlMissing({
              name: asPlain(redis.name) ?? redis.LogicalId,
            }),
        ),
      );
      return options.makeClient(url);
    }),
  );

export const redisCommand = sendRedisCommand;
