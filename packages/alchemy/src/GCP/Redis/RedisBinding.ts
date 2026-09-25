import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as redis from "@distilled.cloud/gcp/redis_v1";
import type { Url } from "../../Redis/index.ts";
import { UrlMissing as RedisUrlMissing } from "../../Redis/index.ts";
import * as Output from "../../Output.ts";
import type { Instance } from "./Instance.ts";

export const REDIS_URL_ENV = "REDIS_URL";

/**
 * Shared scaffolding for Memorystore Redis RESP bindings.
 *
 * Deploy-time resolves the instance's URL (host/port/AUTH) as an Output
 * and transports it to the runtime through the host's RuntimeContext;
 * `REDIS_URL` in the environment is only a fallback. Runtime commands use
 * `alchemy/Redis` over that URL.
 *
 * NOT exported from `index.ts`.
 */

const asString = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Redacted.isRedacted(value)) return asString(Redacted.value(value));
  return value == null ? "" : String(value);
};

const redisUrlFromEnv = Config.Redacted(REDIS_URL_ENV).pipe(
  Effect.map((value) => Redacted.value(value)),
);

const encodeUrl = (options: {
  host: string;
  port: string;
  password: string;
  tls: boolean;
}) => {
  const scheme = options.tls ? "rediss" : "redis";
  const auth =
    options.password.length > 0
      ? `:${encodeURIComponent(options.password)}@`
      : "";
  return `${scheme}://${auth}${options.host}:${options.port}`;
};

const redisUrlFromInstance = (
  instance: Instance,
  getAuthString: (
    input: redis.GetAuthStringProjectsLocationsInstancesRequest,
  ) => Effect.Effect<
    redis.InstanceAuthString,
    redis.GetAuthStringProjectsLocationsInstancesError
  >,
) => {
  const password = Output.flatMap(
    Output.all(
      Output.asOutput(instance.name),
      Output.asOutput(instance.authEnabled),
    ),
    ([name, authEnabled]) => {
      const enabled = authEnabled === true || asString(authEnabled) === "true";
      if (!enabled || asString(name).length === 0) {
        return Output.asOutput("");
      }
      return Output.fromEffect(
        getAuthString({ name: asString(name) }).pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ authString: "" as string }),
          ),
          Effect.map((auth) => auth.authString ?? ""),
          Effect.orDie,
        ),
      );
    },
  );
  return Output.map(
    Output.all(
      Output.asOutput(instance.host),
      Output.asOutput(instance.port),
      Output.asOutput(instance.transitEncryptionMode),
      password,
    ),
    ([host, port, mode, secret]) =>
      encodeUrl({
        host: asString(host),
        port: asString(port) || "6379",
        password: asString(secret),
        tls: asString(mode) === "SERVER_AUTHENTICATION",
      }),
  );
};

export const makeRedisBinding = <Client>(options: {
  makeClient: (url: Url) => Client;
}) =>
  Effect.gen(function* () {
    const getAuthString = yield* redis.getAuthStringProjectsLocationsInstances;
    return Effect.fn(function* (instance: Instance) {
      // The URL (with the AUTH string) travels per instance through the
      // host's RuntimeContext, so two Redis bindings on one host never
      // collide on a shared env var. RESP authenticates with that AUTH
      // string, so the runtime service account needs no IAM role.
      // The auth-string lookup is a deploy-time Output; its requirements
      // are satisfied by the engine, never at runtime.
      const fromContext = yield* redisUrlFromInstance(
        instance,
        getAuthString,
      ) as Output.Output<string, never>;
      const missing = new RedisUrlMissing({ name: instance.LogicalId });
      const url: Url = Effect.gen(function* () {
        const value = yield* fromContext;
        if (typeof value === "string" && value.length > 0) return value;
        return yield* redisUrlFromEnv.pipe(Effect.mapError(() => missing));
      });
      return options.makeClient(url);
    });
  });
