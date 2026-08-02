import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AuthError, getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
import {
  readEnvCredentials,
  SPACETIMEDB_AUTH_PROVIDER_NAME,
  type SpacetimeDBAuthConfig,
  type SpacetimeDBResolvedCredentials,
} from "./AuthProvider.ts";
import { DEFAULT_HOST, normalizeHost } from "./Host.ts";

export interface SpacetimeDBCredentialsService {
  readonly token: Redacted.Redacted<string>;
  /**
   * Absolute origin of the SpacetimeDB host (e.g.
   * `https://maincloud.spacetimedb.com`).
   */
  readonly host: string;
}

export class SpacetimeDBCredentials extends Context.Service<
  SpacetimeDBCredentials,
  Effect.Effect<SpacetimeDBCredentialsService>
>()("SpacetimeDB::Credentials") {}

const make = (
  token: Redacted.Redacted<string>,
  host: string,
): SpacetimeDBCredentialsService => ({
  token,
  host,
});

/**
 * Build a `SpacetimeDBCredentials` layer from a literal token. Useful for
 * tests or when callers already have a token in hand.
 *
 * Pass `host` to target a non-default SpacetimeDB instance (self-hosted or
 * local). Defaults to Maincloud.
 */
export const fromToken = (
  token: string | Redacted.Redacted<string>,
  options?: { readonly host?: string },
) =>
  Layer.succeed(
    SpacetimeDBCredentials,
    Effect.gen(function* () {
      const host =
        options?.host !== undefined
          ? yield* normalizeHost(options.host)
          : DEFAULT_HOST;
      return make(
        typeof token === "string" ? Redacted.make(token) : token,
        host,
      );
    }).pipe(Effect.orDie),
  );

/**
 * Build a `SpacetimeDBCredentials` layer that reads the token from
 * `SPACETIMEDB_TOKEN` or `SPACETIME_TOKEN` at resolve time. Host comes from
 * `SPACETIMEDB_HOST` / `SPACETIME_HOST` / `SPACETIMEDB_SERVER` or defaults to
 * Maincloud.
 */
export const fromEnv = () =>
  Layer.succeed(
    SpacetimeDBCredentials,
    readEnvCredentials().pipe(
      Effect.map((creds) => make(creds.token, creds.host)),
      Effect.orDie,
    ),
  );

/**
 * Build a `SpacetimeDBCredentials` layer that resolves a token via the
 * Alchemy AuthProvider for the configured profile (defaults to `default`,
 * overridable with `ALCHEMY_PROFILE`).
 *
 * Pass `host` to hard-code the SpacetimeDB host — it takes precedence over
 * whatever host the auth provider resolved. `SpacetimeDB.providers({ host })`
 * threads its option here.
 */
export const fromAuthProvider = (options?: { readonly host?: string }) =>
  Layer.effect(
    SpacetimeDBCredentials,
    Effect.gen(function* () {
      const fixedHost =
        options?.host !== undefined
          ? yield* normalizeHost(options.host)
          : undefined;
      const profile = yield* AlchemyProfile;
      const auth = yield* getAuthProvider<
        SpacetimeDBAuthConfig,
        SpacetimeDBResolvedCredentials
      >(SPACETIMEDB_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));

      return yield* profile.loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as SpacetimeDBAuthConfig),
        ),
        Effect.map((creds) =>
          make(creds.token, fixedHost !== undefined ? fixedHost : creds.host),
        ),
        Effect.mapError(
          (e) =>
            new AuthError({
              message: `Failed to resolve SpacetimeDB credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
        Effect.orDie,
        Effect.cached,
      );
    }).pipe(Effect.orDie),
  );
