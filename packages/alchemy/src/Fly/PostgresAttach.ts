import { CredentialsFromEnv } from "@distilled.cloud/fly-io";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Binding from "../Binding.ts";
import type { Resource } from "../Resource.ts";
import type { App } from "./App.ts";
import type { ServiceBinding } from "./MountVolume.ts";
import {
  attachPostgresSecrets,
  DATABASE_URL_SECRET,
  type Postgres,
} from "./Postgres.ts";
import type { Providers } from "./Providers.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* App(...)` and `App(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export interface AttachPostgresOptions {
  /**
   * App to receive `DATABASE_URL`. If omitted, inferred from the host
   * {@link Service} or {@link Machine}.
   */
  app?: Ref<App>;
  /**
   * Env-var name written as the App secret.
   *
   * @default "DATABASE_URL"
   */
  variableName?: string;
}

export interface AttachedPostgres {
  /** Physical Fly App name the secret was written to. */
  appName: string;
  /** Fly Managed Postgres cluster id. */
  clusterId: string;
  /** Secret name (`DATABASE_URL` by default). */
  variableName: string;
}

/**
 * Attach a {@link Postgres} cluster to a Fly {@link App}.
 *
 * Writes `DATABASE_URL` (pooled `pgbouncer_uri`) and `DIRECT_DATABASE_URL`
 * when a direct URI can be built. A {@link Service} reads them with
 * `Config.redacted("DATABASE_URL")`. Do not pass `env: {}`.
 *
 * @binding
 * @see https://fly.io/docs/mpg/create-and-connect/
 *
 * @section Attach from a Service
 * Yield `AttachPostgres` inside init. The App comes from the Service.
 * Provide {@link AttachPostgresLive}. Read `DATABASE_URL` at runtime.
 *
 * @example Bind DATABASE_URL
 * ```typescript
 * import * as Config from "effect/Config";
 *
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     yield* Fly.AttachPostgres(Db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const databaseUrl = yield* Config.redacted("DATABASE_URL");
 *         return HttpServerResponse.text("ok");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Fly.AttachPostgresLive)),
 * ) {}
 * ```
 *
 * @section Attach from the stack
 * Pass `app` when you are not inside a Service.
 *
 * @example Stack attach
 * ```typescript
 * const site = yield* Fly.App("Site");
 * const db = yield* Fly.Postgres("Db", { region: "iad" });
 * yield* Fly.AttachPostgres(db, { app: site });
 * ```
 */
export interface AttachPostgres extends Binding.Service<
  AttachPostgres,
  "Fly.Postgres.Attach",
  (
    postgres: Postgres,
    options?: AttachPostgresOptions,
  ) => Effect.Effect<AttachedPostgres>
> {}

export const AttachPostgres = Binding.Service<AttachPostgres>(
  "Fly.Postgres.Attach",
);

export class AttachAppRequired extends Data.TaggedError(
  "Fly.AttachAppRequired",
)<{
  message: string;
}> {}

export class AttachClusterRequired extends Data.TaggedError(
  "Fly.AttachClusterRequired",
)<{
  message: string;
}> {}

const isFlyHost = (
  value: unknown,
): value is Resource<string, any, any, ServiceBinding> =>
  typeof value === "object" &&
  value !== null &&
  ((value as { Type?: string }).Type === "Fly.Service" ||
    (value as { Type?: string }).Type === "Fly.Machine");

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const readAttr = (value: unknown): Effect.Effect<unknown> =>
  Effect.gen(function* () {
    if (
      value == null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    return yield* value as Effect.Effect<unknown>;
  });

const appNameOf = (value: unknown): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    if (value === undefined) return undefined;
    const fromField = asString(
      yield* readAttr((value as { appName?: unknown }).appName),
    );
    if (fromField !== undefined) return fromField;
    return asString(yield* readAttr(value));
  });

const clusterIdOf = (postgres: Postgres): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    return asString(
      yield* readAttr((postgres as { clusterId?: unknown }).clusterId),
    );
  });

/** Deploy-time implementation of {@link AttachPostgres}. */
export const AttachPostgresLive = Layer.effect(
  AttachPostgres,
  Effect.succeed(
    Effect.fn(function* (postgres: Postgres, options?: AttachPostgresOptions) {
      const variableName = options?.variableName ?? DATABASE_URL_SECRET;
      if (globalThis.__ALCHEMY_RUNTIME__) {
        return {
          appName: "",
          clusterId: "",
          variableName,
        };
      }

      const host = yield* Binding.Host;
      const clusterId = yield* clusterIdOf(postgres);
      if (clusterId === undefined) {
        return yield* new AttachClusterRequired({
          message:
            "Fly.AttachPostgres requires a Postgres cluster with clusterId",
        });
      }

      const appName =
        (yield* appNameOf(options?.app)) ??
        (isFlyHost(host)
          ? asString(yield* readAttr((host as { appName?: unknown }).appName))
          : undefined);
      if (appName === undefined) {
        return yield* new AttachAppRequired({
          message:
            "Fly.AttachPostgres requires an App. Pass { app } or call it from a Service.",
        });
      }

      if (isFlyHost(host)) {
        yield* host.bind`${postgres}`({});
      }

      yield* attachPostgresSecrets(appName, clusterId, variableName);
      return { appName, clusterId, variableName };
    }),
  ),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(CredentialsFromEnv));
