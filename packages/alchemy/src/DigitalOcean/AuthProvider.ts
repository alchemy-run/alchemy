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

export const DIGITALOCEAN_AUTH_PROVIDER_NAME = "DigitalOcean";

export type DigitalOceanAuthConfig = { method: "env" } | { method: "stored" };

export type DigitalOceanStoredCredentials = {
  type: "apiToken";
  apiToken: string;
};

export type DigitalOceanResolvedCredentials = {
  type: "apiToken";
  apiToken: Redacted.Redacted<string>;
  source: { type: DigitalOceanAuthConfig["method"]; details?: string };
};

// doctl reads DIGITALOCEAN_ACCESS_TOKEN; the terraform provider reads
// DIGITALOCEAN_TOKEN. Accept both, preferring DIGITALOCEAN_TOKEN.
const ENV_VARS = ["DIGITALOCEAN_TOKEN", "DIGITALOCEAN_ACCESS_TOKEN"] as const;

const getEnvToken = Effect.gen(function* () {
  for (const name of ENV_VARS) {
    const token = yield* getEnvRedacted(name);
    if (token) return { token, name };
  }
  return undefined;
});

const options: Array<{
  value: DigitalOceanAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
  {
    value: "env",
    label: "Environment Variable",
    hint: "DIGITALOCEAN_TOKEN or DIGITALOCEAN_ACCESS_TOKEN",
  },
  {
    value: "stored",
    label: "API Token",
    hint: "enter interactively, stored in ~/.alchemy/credentials",
  },
];

/**
 * Layer that registers the DigitalOcean {@link AuthProvider} into the
 * {@link AuthProviders} registry.
 */
export const DigitalOceanAuth = AuthProviderLayer<
  DigitalOceanAuthConfig,
  DigitalOceanResolvedCredentials
>()(
  DIGITALOCEAN_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const profiles = yield* AlchemyProfile;
    const store = yield* CredentialsStore;

    const loginStored = Effect.fn(function* (profileName: string) {
      const apiToken = yield* Clank.password({
        message: "DigitalOcean API Token",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      yield* store.write<DigitalOceanStoredCredentials>(
        profileName,
        "digitalocean-stored",
        {
          type: "apiToken",
          apiToken,
        },
      );
      yield* Clank.success("DigitalOcean: credentials saved.");
      return { method: "stored" as const };
    });

    const configureInteractive = (profileName: string) =>
      Clank.select({
        message: "DigitalOcean authentication method",
        options,
      }).pipe(
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("env", () => Effect.succeed({ method: "env" as const })),
            Match.when("stored", () => loginStored(profileName)),
            Match.exhaustive,
          ),
        ),
      );

    const configureCredentials = (profileName: string, ctx: ConfigureContext) =>
      (ctx.ci
        ? Effect.succeed({ method: "env" as const })
        : configureInteractive(profileName)
      ).pipe(
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
      config: DigitalOceanAuthConfig,
    ): Effect.Effect<DigitalOceanResolvedCredentials, AuthError> =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () =>
          Effect.gen(function* () {
            const env = yield* getEnvToken;
            if (!env) {
              return yield* new AuthError({
                message:
                  "DigitalOcean env credentials not found. Set DIGITALOCEAN_TOKEN (or DIGITALOCEAN_ACCESS_TOKEN).",
              });
            }
            return {
              type: "apiToken" as const,
              apiToken: env.token,
              source: { type: "env" as const, details: env.name },
            };
          }),
        ),
        Match.when({ method: "stored" }, () =>
          store
            .read<DigitalOceanStoredCredentials>(
              profileName,
              "digitalocean-stored",
            )
            .pipe(
              Effect.flatMap((creds) =>
                creds == null
                  ? Effect.fail(
                      new AuthError({
                        message:
                          "DigitalOcean stored credentials not found. Run: alchemy login --configure",
                      }),
                    )
                  : Effect.succeed({
                      type: "apiToken" as const,
                      apiToken: Redacted.make(creds.apiToken),
                      source: { type: "stored" as const },
                    }),
              ),
            ),
        ),
        Match.exhaustive,
      );

    const logout = (profileName: string, config: DigitalOceanAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, "digitalocean-stored")
            .pipe(
              Effect.andThen(
                Clank.success("DigitalOcean: stored credentials removed"),
              ),
            ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: DigitalOceanAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "env" }, () =>
            // If neither env var is set, fall through to the interactive
            // picker so the user can switch to `stored` (or be told to set
            // the env var) instead of silently failing later in `read`. The
            // new selection is persisted to the profile so subsequent logins
            // don't re-prompt.
            getEnvToken.pipe(
              Effect.flatMap((env) =>
                env
                  ? Effect.void
                  : Effect.gen(function* () {
                      const next = yield* configureInteractive(profileName);
                      const existing = yield* profiles.getProfile(profileName);
                      yield* profiles.setProfile(profileName, {
                        ...existing,
                        [DIGITALOCEAN_AUTH_PROVIDER_NAME]: next,
                      });
                    }),
              ),
            ),
          ),
          Match.when({ method: "stored" }, () =>
            store
              .read<DigitalOceanStoredCredentials>(
                profileName,
                "digitalocean-stored",
              )
              .pipe(
                Effect.flatMap((creds) =>
                  creds == null ? loginStored(profileName) : Effect.void,
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

    const prettyPrint = (profileName: string, config: DigitalOceanAuthConfig) =>
      resolveCredentials(profileName, config).pipe(
        Effect.tap((creds) => {
          const sourceStr = creds.source.details
            ? `${creds.source.type} - ${creds.source.details}`
            : creds.source.type;
          return Console.log(
            `  apiToken: ${displayRedacted(creds.apiToken, 9)}`,
          ).pipe(Effect.andThen(Console.log(`  source: ${sourceStr}`)));
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
