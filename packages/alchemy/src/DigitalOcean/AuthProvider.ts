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

const STORED_CREDENTIALS_FILE = "digitalocean-stored";

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

// `doctl` reads `DIGITALOCEAN_ACCESS_TOKEN`. The Terraform provider reads
// `DIGITALOCEAN_TOKEN`. The first name in the list wins.
const ENV_VARS = ["DIGITALOCEAN_TOKEN", "DIGITALOCEAN_ACCESS_TOKEN"] as const;

const getEnvToken = Effect.gen(function* () {
  for (const name of ENV_VARS) {
    const token = yield* getEnvRedacted(name);
    if (token) return { token, name };
  }
  return undefined;
});

const authMethodOptions: Array<{
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

    const readStored = (profileName: string) =>
      store.read<DigitalOceanStoredCredentials>(
        profileName,
        STORED_CREDENTIALS_FILE,
      );

    const loginStored = Effect.fn(function* (profileName: string) {
      const apiToken = yield* Clank.password({
        message: "DigitalOcean API Token",
        validate: (value) => (value.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      yield* store.write<DigitalOceanStoredCredentials>(
        profileName,
        STORED_CREDENTIALS_FILE,
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
        options: authMethodOptions,
      }).pipe(
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("env", () => Effect.succeed({ method: "env" as const })),
            Match.when("stored", () => loginStored(profileName)),
            Match.exhaustive,
          ),
        ),
      );

    const configureCredentials = (
      profileName: string,
      context: ConfigureContext,
    ) =>
      (context.ci
        ? Effect.succeed({ method: "env" as const })
        : configureInteractive(profileName)
      ).pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "DigitalOcean: cannot configure credentials.",
              cause,
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
          Effect.gen(function* () {
            const credentials = yield* readStored(profileName);
            if (credentials === undefined) {
              return yield* new AuthError({
                message:
                  "DigitalOcean stored credentials not found. Run: alchemy login --configure",
              });
            }
            return {
              type: "apiToken" as const,
              apiToken: Redacted.make(credentials.apiToken),
              source: { type: "stored" as const },
            };
          }),
        ),
        Match.exhaustive,
      );

    const logout = (profileName: string, config: DigitalOceanAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, STORED_CREDENTIALS_FILE)
            .pipe(
              Effect.andThen(
                Clank.success("DigitalOcean: stored credentials removed"),
              ),
            ),
        ),
        Match.exhaustive,
      );

    // No env var is set. Open the picker so the user can switch to
    // `stored`. Save the choice so the next login does not prompt again.
    const promptWhenEnvMissing = Effect.fn(function* (profileName: string) {
      const next = yield* configureInteractive(profileName);
      const existing = yield* profiles.getProfile(profileName);
      yield* profiles.setProfile(profileName, {
        ...existing,
        [DIGITALOCEAN_AUTH_PROVIDER_NAME]: next,
      });
    });

    const loginWithEnv = Effect.fn(function* (profileName: string) {
      const env = yield* getEnvToken;
      if (env === undefined) yield* promptWhenEnvMissing(profileName);
    });

    const loginWithStored = Effect.fn(function* (profileName: string) {
      const credentials = yield* readStored(profileName);
      if (credentials === undefined) yield* loginStored(profileName);
    });

    const login = (profileName: string, config: DigitalOceanAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => loginWithEnv(profileName)),
        Match.when({ method: "stored" }, () => loginWithStored(profileName)),
        Match.exhaustive,
        Effect.mapError(
          (cause) =>
            new AuthError({ message: "DigitalOcean: login failed.", cause }),
        ),
      );

    const prettyPrint = (profileName: string, config: DigitalOceanAuthConfig) =>
      resolveCredentials(profileName, config).pipe(
        Effect.tap((credentials) => {
          const sourceLabel = credentials.source.details
            ? `${credentials.source.type} - ${credentials.source.details}`
            : credentials.source.type;
          return Console.log(
            `  apiToken: ${displayRedacted(credentials.apiToken, 9)}`,
          ).pipe(Effect.andThen(Console.log(`  source: ${sourceLabel}`)));
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
