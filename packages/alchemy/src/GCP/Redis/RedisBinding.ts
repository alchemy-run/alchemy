import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as redis from "@distilled.cloud/gcp/redis_v1";
import type { Url } from "../../Redis/index.ts";
import { UrlMissing as RedisUrlMissing } from "../../Redis/index.ts";
import { bindGcpHost } from "../Host.ts";
import type { Instance } from "./Instance.ts";

export const REDIS_URL_ENV = "REDIS_URL";

/**
 * Shared scaffolding for Memorystore Redis RESP bindings.
 *
 * Deploy-time packs `REDIS_URL` (host/port/AUTH) onto the Cloud Run /
 * Function host and grants `roles/redis.editor`. Runtime commands use
 * `alchemy/Redis` over that URL.
 *
 * NOT exported from `index.ts`.
 */

const asPlain = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Redacted.isRedacted(value)) return asPlain(Redacted.value(value));
  return undefined;
};

const readOutput = (value: unknown): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const direct = asPlain(value);
    if (direct !== undefined) return direct;
    if (Effect.isEffect(value)) {
      return asPlain(yield* value as Effect.Effect<unknown>);
    }
    return undefined;
  });

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

export const makeRedisBinding = <Client>(options: {
  makeClient: (url: Url) => Client;
  role: string;
}) =>
  Effect.gen(function* () {
    const getAuthString = yield* redis.getAuthStringProjectsLocationsInstances;
    return Effect.fn(function* (instance: Instance) {
      const name = (yield* readOutput(instance.name)) ?? instance.LogicalId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const hostName = (yield* readOutput(instance.host)) ?? "";
        const port = (yield* readOutput(instance.port)) ?? "6379";
        const tls =
          (yield* readOutput(instance.transitEncryptionMode)) ===
          "SERVER_AUTHENTICATION";
        let password = "";
        const authEnabled = yield* readOutput(instance.authEnabled);
        if (authEnabled === "true") {
          const auth = yield* getAuthString({ name }).pipe(
            Effect.catch(() => Effect.succeed({ authString: "" as string })),
          );
          password = auth.authString ?? "";
        }
        if (hostName.length > 0) {
          yield* bindGcpHost({
            tag: "GCP.Redis.RESP",
            resource: instance,
            iam: [{ role: options.role }],
            env: {
              [REDIS_URL_ENV]: encodeUrl({
                host: hostName,
                port,
                password,
                tls,
              }),
            },
          });
        }
      }

      const url = redisUrlFromEnv.pipe(
        Effect.mapError(() => new RedisUrlMissing({ name })),
      );
      return options.makeClient(url);
    }) as (instance: Instance) => Effect.Effect<Client>;
  });
