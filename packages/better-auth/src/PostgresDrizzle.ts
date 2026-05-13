import { Random } from "alchemy";
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
 * A Postgres connection source. Either a Cloudflare Hyperdrive resource, a
 * plain connection URL string, a `Redacted<string>`, or an Effect resolving
 * to one. Use a Hyperdrive resource inside Cloudflare Workers for pooled
 * connections; use a URL for Neon/Supabase direct or any non-Hyperdrive
 * Postgres source.
 */
export type PostgresSource =
  | Hyperdrive
  | string
  | Redacted.Redacted<string>
  | Effect.Effect<Redacted.Redacted<string>>;

/**
 * Options for {@link postgresDrizzle}: the full `BetterAuthOptions` (minus
 * `database` and `secret`, supplied internally) plus a flat pass-through of
 * `drizzleAdapter` config (minus `provider`, fixed to `"pg"`).
 */
export type PostgresDrizzleOptions<TRelations extends AnyRelations> = Omit<
  BetterAuthOptions,
  "database" | "secret"
> &
  Omit<DrizzleAdapterConfig, "provider"> & {
    db: PostgresSource;
  };

const resolveConnectionString = (db: PostgresSource) => {
  if (typeof db === "string") return Effect.succeed(Redacted.make(db));
  if (Redacted.isRedacted(db)) return Effect.succeed(db);
  if (Effect.isEffect(db)) return db;
  return Effect.gen(function* () {
    const hd = yield* Cloudflare.Hyperdrive.bind(db);
    return yield* hd.connectionString;
  });
};

/**
 * Wires `better-auth` to a Postgres database via `drizzle-orm`. Accepts
 * either a Cloudflare Hyperdrive resource (for pooled connections inside
 * Workers) or a plain connection URL (Neon/Supabase direct, env URL, etc.)
 * via the `db` option.
 *
 * Pass any `BetterAuthOptions` you'd normally pass to `betterAuth(...)`
 * plus the `drizzleAdapter` schema/config. The `database` field is
 * supplied internally using `Drizzle.postgresRaw(...)` (a vanilla
 * `drizzle-orm/node-postgres` client). The drizzle pool is cached
 * per-`ExecutionContext`. The `secret` is auto-generated and persisted
 * via an `Alchemy.Random` resource — no manual juggling of
 * `BETTER_AUTH_SECRET` required.
 *
 * @section Wiring better-auth to Postgres
 * @example From a Hyperdrive resource
 * ```typescript
 * import * as BetterAuth from "@alchemy.run/better-auth";
 *
 * .pipe(
 *   Effect.provide(
 *     BetterAuth.postgresDrizzle({
 *       db: MyHyperdrive,
 *       baseURL: "https://app.example.com",
 *       basePath: "/api/auth",
 *       schema: { user, session, account, verification },
 *       plugins: [emailOTP({ ... })],
 *     }),
 *   ),
 * )
 * ```
 *
 * @example From a connection URL
 * ```typescript
 * import * as BetterAuth from "@alchemy.run/better-auth";
 *
 * .pipe(
 *   Effect.provide(
 *     BetterAuth.postgresDrizzle({
 *       db: process.env.DATABASE_URL!,
 *       schema: { user, session, account, verification },
 *     }),
 *   ),
 * )
 * ```
 *
 * @section Consuming in a route
 * @example Forwarding `/api/auth/*`
 * ```typescript
 * const auth = yield* BetterAuth.BetterAuth;
 * if (url.pathname.startsWith("/api/auth/")) return yield* auth.fetch;
 * ```
 */
export const postgresDrizzle = <
  TRelations extends AnyRelations = EmptyRelations,
>(
  options: PostgresDrizzleOptions<TRelations>,
) => {
  const {
    db,
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
      const secretResource = yield* Random("BetterAuthSecret");
      const secretAccessor = yield* secretResource.text;
      const connectionString = resolveConnectionString(db);
      const auth = Effect.gen(function* () {
        const raw = yield* Drizzle.postgresRaw(connectionString);
        const secret = yield* secretAccessor;
        return makeBetterAuth({
          ...betterAuthOptions,
          secret: Redacted.value(secret),
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
  ).pipe(Layer.provide(Cloudflare.HyperdriveBindingLive));
};
