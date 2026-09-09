import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as redis from "@distilled.cloud/gcp/redis_v1";
import type { Url } from "../../Redis/index.ts";
import { UrlMissing as RedisUrlMissing } from "../../Redis/index.ts";
import * as Output from "../../Output.ts";
import { bindGcpHost } from "../Host.ts";
import type { Instance } from "./Instance.ts";

export const REDIS_URL_ENV = "REDIS_URL";

/**
 * Shared scaffolding for Memorystore Redis RESP bindings.
 *
 * Deploy-time packs `REDIS_URL` (host/port/AUTH) onto the Cloud Run /
 * Function host as an Output the engine resolves at reconcile, and
 * grants `roles/redis.editor`. Runtime commands use `alchemy/Redis`
 * over that URL.
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

const redisUrlFromEnv = Config.redacted(REDIS_URL_ENV).pipe(
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
  role: string;
}) =>
  Effect.gen(function* () {
    const getAuthString = yield* redis.getAuthStringProjectsLocationsInstances;
    return Effect.fn(function* (instance: Instance) {
      const name = instance.LogicalId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bindGcpHost({
          tag: "GCP.Redis.RESP",
          resource: instance,
          iam: [{ role: options.role }],
          env: {
            [REDIS_URL_ENV]: redisUrlFromInstance(instance, getAuthString),
          },
        });
      }

      const url = redisUrlFromEnv.pipe(
        Effect.mapError(() => new RedisUrlMissing({ name })),
      );
      return options.makeClient(url);
    });
  });
