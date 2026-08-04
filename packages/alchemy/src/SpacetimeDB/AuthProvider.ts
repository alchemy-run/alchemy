import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureContext,
} from "../Auth/AuthProvider.ts";
import { CredentialsStore, displayRedacted } from "../Auth/Credentials.ts";
import { getEnvRedacted, retryOnce } from "../Auth/Env.ts";
import { AlchemyProfile } from "../Auth/Profile.ts";
import * as Clank from "../Util/Clank.ts";
import { DEFAULT_HOST, normalizeHost, resolveHostFromEnv } from "./Host.ts";

export const SPACETIMEDB_AUTH_PROVIDER_NAME = "SpacetimeDB";

export type SpacetimeDBAuthConfig =
  | { method: "env"; host?: string }
  | { method: "stored"; host?: string };

export type SpacetimeDBStoredCredentials = {
  type: "token";
  token: string;
};

export type SpacetimeDBResolvedCredentials = {
  type: "token";
  token: Redacted.Redacted<string>;
  host: string;
  source: { type: SpacetimeDBAuthConfig["method"]; details?: string };
};

const options: Array<{
  value: SpacetimeDBAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
  {
    value: "env",
    label: "Environment Variable",
    hint: "SPACETIMEDB_TOKEN or SPACETIME_TOKEN",
  },
  {
    value: "stored",
    label: "Token",
    hint: "enter interactively, stored in ~/.alchemy/credentials",
  },
];

/**
 * Read a SpacetimeDB token from the environment (`SPACETIMEDB_TOKEN` or
 * `SPACETIME_TOKEN`). Host is resolved from the config or the environment.
 */
export const readEnvCredentials = (
  configHost?: string,
): Effect.Effect<SpacetimeDBResolvedCredentials, AuthError> =>
  Effect.gen(function* () {
    const host =
      configHost !== undefined
        ? yield* normalizeHost(configHost)
        : yield* resolveHostFromEnv;
    for (const key of ["SPACETIMEDB_TOKEN", "SPACETIME_TOKEN"] as const) {
      const token = yield* getEnvRedacted(key);
      if (token) {
        return {
          type: "token" as const,
          token,
          host,
          source: { type: "env" as const, details: key },
        };
      }
    }
    return yield* new AuthError({
      message:
        "SpacetimeDB env credentials not found. Set SPACETIMEDB_TOKEN (or SPACETIME_TOKEN). Obtain a token via `spacetime login` / `spacetime login show --token`.",
    });
  });

export interface SpacetimeDBAuthOptions {
  /**
   * Hard-code the SpacetimeDB host (e.g. `maincloud` or
   * `https://maincloud.spacetimedb.com`). When set it takes precedence over
   * the profile and environment. `SpacetimeDB.providers({ host })` threads
   * its option here.
   */
  readonly host?: string;
}

/**
 * Layer that registers the SpacetimeDB {@link AuthProvider} into the
 * {@link AuthProviders} registry so `alchemy login` can configure it.
 */
export const makeSpacetimeDBAuth = (authOptions?: SpacetimeDBAuthOptions) =>
  AuthProviderLayer<SpacetimeDBAuthConfig, SpacetimeDBResolvedCredentials>()(
    SPACETIMEDB_AUTH_PROVIDER_NAME,
    Effect.gen(function* () {
      const profiles = yield* AlchemyProfile;
      const store = yield* CredentialsStore;

      const fixed =
        authOptions?.host !== undefined
          ? { host: yield* normalizeHost(authOptions.host).pipe(Effect.orDie) }
          : undefined;

      const effectiveHost = (
        config: SpacetimeDBAuthConfig,
      ): Effect.Effect<string, AuthError> =>
        fixed !== undefined
          ? Effect.succeed(fixed.host)
          : config.host !== undefined
            ? normalizeHost(config.host)
            : resolveHostFromEnv;

      const loginStored = Effect.fn(function* (
        profileName: string,
        host?: string,
      ) {
        const token = yield* Clank.password({
          message:
            "SpacetimeDB token (from `spacetime login show --token` or the Maincloud dashboard)",
          validate: (v) => (v.length === 0 ? "Required" : undefined),
        }).pipe(retryOnce);

        yield* store.write<SpacetimeDBStoredCredentials>(
          profileName,
          "spacetimedb-stored",
          {
            type: "token",
            token,
          },
        );
        yield* Clank.success("SpacetimeDB: credentials saved.");
        return { method: "stored" as const, host };
      });

      const promptHost = Clank.text({
        message: `SpacetimeDB host (leave blank for ${DEFAULT_HOST.replace("https://", "")})`,
        placeholder: "maincloud",
      }).pipe(
        Effect.flatMap((raw) => {
          const trimmed = raw.trim();
          return trimmed.length === 0
            ? Effect.succeed(undefined as string | undefined)
            : normalizeHost(trimmed);
        }),
        Effect.mapError(
          (e) =>
            new AuthError({
              message: "failed to resolve SpacetimeDB host",
              cause: e,
            }),
        ),
      );

      const configureInteractive = (profileName: string) =>
        Effect.gen(function* () {
          const host = fixed !== undefined ? fixed.host : yield* promptHost;
          const method = yield* Clank.select({
            message: "SpacetimeDB authentication method",
            options,
          });
          return yield* Match.value(method).pipe(
            Match.when("env", () =>
              Effect.succeed({ method: "env" as const, host }),
            ),
            Match.when("stored", () => loginStored(profileName, host)),
            Match.exhaustive,
          );
        });

      const configureCredentials = (
        profileName: string,
        ctx: ConfigureContext,
      ) =>
        Effect.gen(function* () {
          if (ctx.ci) {
            return {
              method: "env" as const,
              host: fixed?.host,
            };
          }
          return yield* configureInteractive(profileName);
        }).pipe(
          Effect.mapError(
            (e) =>
              new AuthError({
                message: "failed to configure credentials",
                cause: e,
              }),
          ),
        );

      const resolveCredentials = (
        profileName: string,
        config: SpacetimeDBAuthConfig,
      ): Effect.Effect<SpacetimeDBResolvedCredentials, AuthError> =>
        Match.value(config).pipe(
          Match.when({ method: "env" }, (c) =>
            readEnvCredentials(fixed !== undefined ? fixed.host : c.host).pipe(
              Effect.map((creds) =>
                fixed !== undefined ? { ...creds, host: fixed.host } : creds,
              ),
            ),
          ),
          Match.when({ method: "stored" }, (c) =>
            store
              .read<SpacetimeDBStoredCredentials>(
                profileName,
                "spacetimedb-stored",
              )
              .pipe(
                Effect.flatMap((creds) =>
                  creds == null
                    ? Effect.fail(
                        new AuthError({
                          message:
                            "SpacetimeDB stored credentials not found. Run: alchemy login --configure",
                        }),
                      )
                    : Effect.gen(function* () {
                        const host = yield* effectiveHost(c);
                        return {
                          type: "token" as const,
                          token: Redacted.make(creds.token),
                          host,
                          source: { type: "stored" as const },
                        };
                      }),
                ),
              ),
          ),
          Match.exhaustive,
        );

      const logout = (profileName: string, config: SpacetimeDBAuthConfig) =>
        Match.value(config).pipe(
          Match.when({ method: "env" }, () => Effect.void),
          Match.when({ method: "stored" }, () =>
            store
              .delete(profileName, "spacetimedb-stored")
              .pipe(
                Effect.andThen(
                  Clank.success("SpacetimeDB: stored credentials removed"),
                ),
              ),
          ),
          Match.exhaustive,
        );

      const login = (profileName: string, config: SpacetimeDBAuthConfig) =>
        Match.value(config)
          .pipe(
            Match.when({ method: "env" }, () =>
              getEnvRedacted("SPACETIMEDB_TOKEN").pipe(
                Effect.flatMap((token) =>
                  token
                    ? Effect.void
                    : getEnvRedacted("SPACETIME_TOKEN").pipe(
                        Effect.flatMap((fallback) =>
                          fallback
                            ? Effect.void
                            : Effect.gen(function* () {
                                const next =
                                  yield* configureInteractive(profileName);
                                const existing =
                                  yield* profiles.getProfile(profileName);
                                yield* profiles.setProfile(profileName, {
                                  ...existing,
                                  [SPACETIMEDB_AUTH_PROVIDER_NAME]: next,
                                });
                              }),
                        ),
                      ),
                ),
              ),
            ),
            Match.when({ method: "stored" }, (c) =>
              store
                .read<SpacetimeDBStoredCredentials>(
                  profileName,
                  "spacetimedb-stored",
                )
                .pipe(
                  Effect.flatMap((creds) =>
                    creds == null
                      ? loginStored(profileName, c.host)
                      : Effect.void,
                  ),
                ),
            ),
            Match.exhaustive,
          )
          .pipe(
            Effect.mapError(
              (e) => new AuthError({ message: "login failed", cause: e }),
            ),
          );

      const prettyPrint = (
        profileName: string,
        config: SpacetimeDBAuthConfig,
      ) =>
        resolveCredentials(profileName, config).pipe(
          Effect.tap((creds) => {
            const sourceStr = creds.source.details
              ? `${creds.source.type} - ${creds.source.details}`
              : creds.source.type;
            return Effect.all([
              Console.log(`  token: ${displayRedacted(creds.token, 9)}`),
              Console.log(`  host:  ${creds.host}`),
              Console.log(`  source: ${sourceStr}`),
            ]);
          }),
        );

      return {
        configure: configureCredentials,
        logout,
        login,
        prettyPrint,
        read: resolveCredentials,
      };
    }),
  );

/** Default auth layer targeting Maincloud (no hard-coded host). */
export const SpacetimeDBAuth = makeSpacetimeDBAuth();
