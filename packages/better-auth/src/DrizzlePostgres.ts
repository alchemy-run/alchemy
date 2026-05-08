import * as Cloudflare from "alchemy/Cloudflare";
import type { Hyperdrive } from "alchemy/Cloudflare/Hyperdrive";
import * as Drizzle from "alchemy/Drizzle";
import {
  type Auth,
  type BetterAuthOptions,
  betterAuth as makeBetterAuth,
} from "better-auth";
import {
  drizzleAdapter,
  type DrizzleAdapterConfig,
} from "better-auth/adapters/drizzle";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { BetterAuth } from "./BetterAuth.ts";

/**
 * Common options accepted by every `DrizzlePostgres.from*` factory: the full
 * `BetterAuthOptions` (minus `database`, supplied internally) plus a flat
 * pass-through of `drizzleAdapter` config (minus `provider`, fixed to `"pg"`).
 */
export type DrizzlePostgresOptions<TRelations extends AnyRelations> = Omit<
  BetterAuthOptions,
  "database"
> &
  Omit<DrizzleAdapterConfig, "provider">;

/**
 * Builds the `BetterAuth` service from a connection-string Effect that has
 * no further requirements (i.e. already-resolved against the runtime env).
 */
const buildLayer = <TRelations extends AnyRelations>(
  connectionString: Effect.Effect<Redacted.Redacted<string>>,
  options: DrizzlePostgresOptions<TRelations>,
) => {
  const {
    schema,
    usePlural,
    debugLogs,
    camelCase,
    transaction,
    ...betterAuthOptions
  } = options;
  return Layer.effect(
    BetterAuth,
    Effect.gen(function* () {
      const db = yield* Drizzle.postgres(connectionString);

      const auth = Effect.gen(function* () {
        const raw = yield* db.raw;
        return makeBetterAuth({
          ...betterAuthOptions,
          database: drizzleAdapter(raw, {
            provider: "pg",
            schema,
            usePlural,
            debugLogs,
            camelCase,
            transaction,
          }),
        });
      }) as unknown as Effect.Effect<Auth<any>>;

      return {
        auth,
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const a = yield* auth;
          const response = yield* Effect.promise(() =>
            a.handler(request.source as Request),
          );
          return HttpServerResponse.fromWeb(response);
        }),
      };
    }),
  );
};

/**
 * Wires `better-auth` to a Postgres database via `drizzle-orm`. Pass any
 * `BetterAuthOptions` you'd normally pass to `betterAuth(...)` plus the
 * `drizzleAdapter` schema/config. The `database` field is supplied
 * internally using `Drizzle.postgres(...).raw` (a vanilla
 * `drizzle-orm/node-postgres` client). The drizzle pool is cached
 * per-`ExecutionContext`; the better-auth instance is cached so it's
 * constructed at most once per JS realm.
 *
 * Two factories — pick by where your connection string comes from.
 *
 * @example Cloudflare Hyperdrive
 * ```typescript
 * import { BetterAuth, DrizzlePostgres } from "@alchemy.run/better-auth";
 *
 * .pipe(
 *   Effect.provide(
 *     DrizzlePostgres.fromHyperdrive({
 *       hyperdrive: MyHyperdrive,
 *       secret: process.env.BETTER_AUTH_SECRET!,
 *       baseURL: "https://app.example.com",
 *       basePath: "/api/auth",
 *       schema: { user, session, account, verification },
 *       plugins: [emailOTP({ ... })],
 *     }),
 *   ),
 * )
 *
 * // in routes:
 * const auth = yield* BetterAuth;
 * if (url.pathname.startsWith("/api/auth/")) return yield* auth.fetch;
 * ```
 *
 * @example Plain URL (Neon, Supabase direct, env var, …)
 * ```typescript
 * .pipe(
 *   Effect.provide(
 *     DrizzlePostgres.fromUrl({
 *       url: process.env.DATABASE_URL!,
 *       secret: process.env.BETTER_AUTH_SECRET!,
 *       schema: { user, session, account, verification },
 *     }),
 *   ),
 * )
 * ```
 */
export const DrizzlePostgres = {
  /**
   * Build the `BetterAuth` layer from a Cloudflare Hyperdrive resource.
   * Provides `Cloudflare.HyperdriveBindingLive` internally so consumers
   * don't need to wire it up.
   */
  fromHyperdrive: <TRelations extends AnyRelations = EmptyRelations>(
    options: DrizzlePostgresOptions<TRelations> & { hyperdrive: Hyperdrive },
  ) => {
    const { hyperdrive, ...rest } = options;
    return Layer.unwrap(
      Effect.gen(function* () {
        const hd = yield* Cloudflare.Hyperdrive.bind(hyperdrive);
        return buildLayer<TRelations>(hd.connectionString, rest);
      }),
    ).pipe(Layer.provide(Cloudflare.HyperdriveBindingLive));
  },

  /**
   * Build the `BetterAuth` layer from a plain Postgres connection URL —
   * a literal string, a `Redacted<string>`, or an Effect resolving to one.
   * Use for Neon, Supabase direct connections, or any non-Hyperdrive
   * Postgres source.
   */
  fromUrl: <TRelations extends AnyRelations = EmptyRelations>(
    options: DrizzlePostgresOptions<TRelations> & {
      url:
        | string
        | Redacted.Redacted<string>
        | Effect.Effect<Redacted.Redacted<string>>;
    },
  ) => {
    const { url, ...rest } = options;
    const connectionString: Effect.Effect<Redacted.Redacted<string>> =
      typeof url === "string"
        ? Effect.succeed(Redacted.make(url))
        : Redacted.isRedacted(url)
          ? Effect.succeed(url)
          : url;
    return buildLayer<TRelations>(connectionString, rest);
  },
};
