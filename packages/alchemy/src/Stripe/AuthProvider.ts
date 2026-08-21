import { DEFAULT_API_BASE_URL } from "@distilled.cloud/stripe";
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
import { getEnv, getEnvRedacted, retryOnce } from "../Auth/Env.ts";
import { AlchemyProfile } from "../Auth/Profile.ts";
import * as Clank from "../Util/Clank.ts";

export const STRIPE_AUTH_PROVIDER_NAME = "Stripe";
export const STRIPE_API_KEY_ENV = "STRIPE_API_KEY";
export const STRIPE_API_BASE_URL_ENV = "STRIPE_API_BASE_URL";

const STORAGE_KEY = "stripe-stored";

export type StripeAuthConfig = { method: "env" } | { method: "stored" };

export type StripeStoredCredentials = {
  type: "apiKey";
  apiKey: string;
  apiBaseUrl?: string;
};

export type StripeResolvedCredentials = {
  type: "apiKey";
  apiKey: Redacted.Redacted<string>;
  apiBaseUrl: string;
  source: { type: StripeAuthConfig["method"]; details?: string };
};

const options: Array<{
  value: StripeAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
  {
    value: "env",
    label: "Environment Variables",
    hint: `${STRIPE_API_KEY_ENV} + optional ${STRIPE_API_BASE_URL_ENV}`,
  },
  {
    value: "stored",
    label: "Secret API Key",
    hint: "enter interactively, stored in ~/.alchemy/credentials",
  },
];

const resolveApiBaseUrl = (explicit?: string) =>
  getEnv(STRIPE_API_BASE_URL_ENV).pipe(
    Effect.map((fromEnv) => explicit ?? fromEnv ?? DEFAULT_API_BASE_URL),
  );

/**
 * Layer that registers the Stripe {@link AuthProvider} into the
 * {@link AuthProviders} registry. Include this in the Stripe `providers()`
 * layer so `alchemy login` can discover it.
 *
 * Auth is a Stripe secret API key (`STRIPE_API_KEY`, typically `sk_test_…`
 * or `sk_live_…`). There is no OAuth flow. An optional
 * `STRIPE_API_BASE_URL` overrides the API root (default
 * `https://api.stripe.com`).
 */
export const StripeAuth = AuthProviderLayer<
  StripeAuthConfig,
  StripeResolvedCredentials
>()(
  STRIPE_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const profiles = yield* AlchemyProfile;
    const store = yield* CredentialsStore;

    const loginStored = Effect.fn(function* (profileName: string) {
      const apiKey = yield* Clank.password({
        message: "Stripe Secret API Key",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      const envBase = yield* getEnv(STRIPE_API_BASE_URL_ENV);
      const basePrompt = yield* Clank.text({
        message: "Stripe API base URL (Enter for default)",
        placeholder: DEFAULT_API_BASE_URL,
        defaultValue: envBase ?? DEFAULT_API_BASE_URL,
      }).pipe(retryOnce);
      const trimmed = (basePrompt ?? "").trim();
      const apiBaseUrl =
        trimmed.length > 0 && trimmed !== DEFAULT_API_BASE_URL
          ? trimmed
          : undefined;

      yield* store.write<StripeStoredCredentials>(profileName, STORAGE_KEY, {
        type: "apiKey",
        apiKey,
        apiBaseUrl,
      });
      yield* Clank.success("Stripe: credentials saved.");
      return { method: "stored" as const };
    });

    const configureInteractive = (profileName: string) =>
      Clank.select({
        message: "Stripe authentication method",
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
      Effect.gen(function* () {
        if (ctx.ci) {
          return { method: "env" as const };
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
      config: StripeAuthConfig,
    ): Effect.Effect<StripeResolvedCredentials, AuthError> =>
      Match.value(config).pipe(
        Match.when(
          { method: "env" },
          Effect.fn(function* () {
            const apiKey = yield* getEnvRedacted(STRIPE_API_KEY_ENV);
            if (!apiKey) {
              return yield* new AuthError({
                message: `Stripe env credentials not found. Set ${STRIPE_API_KEY_ENV}.`,
              });
            }
            const apiBaseUrl = yield* resolveApiBaseUrl();
            return {
              type: "apiKey" as const,
              apiKey,
              apiBaseUrl,
              source: { type: "env" as const, details: STRIPE_API_KEY_ENV },
            };
          }),
        ),
        Match.when({ method: "stored" }, () =>
          store.read<StripeStoredCredentials>(profileName, STORAGE_KEY).pipe(
            Effect.flatMap((creds) =>
              creds == null
                ? Effect.fail(
                    new AuthError({
                      message:
                        "Stripe stored credentials not found. Run: alchemy login --configure",
                    }),
                  )
                : resolveApiBaseUrl(creds.apiBaseUrl).pipe(
                    Effect.map((apiBaseUrl) => ({
                      type: "apiKey" as const,
                      apiKey: Redacted.make(creds.apiKey),
                      apiBaseUrl,
                      source: { type: "stored" as const },
                    })),
                  ),
            ),
          ),
        ),
        Match.exhaustive,
      );

    const logout = (profileName: string, config: StripeAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, STORAGE_KEY)
            .pipe(
              Effect.andThen(
                Clank.success("Stripe: stored credentials removed"),
              ),
            ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: StripeAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "env" }, () =>
            getEnvRedacted(STRIPE_API_KEY_ENV).pipe(
              Effect.flatMap((apiKey) =>
                apiKey
                  ? Effect.void
                  : Effect.gen(function* () {
                      const next = yield* configureInteractive(profileName);
                      const existing = yield* profiles.getProfile(profileName);
                      yield* profiles.setProfile(profileName, {
                        ...existing,
                        [STRIPE_AUTH_PROVIDER_NAME]: next,
                      });
                    }),
              ),
            ),
          ),
          Match.when({ method: "stored" }, () =>
            store
              .read<StripeStoredCredentials>(profileName, STORAGE_KEY)
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

    const prettyPrint = (profileName: string, config: StripeAuthConfig) =>
      resolveCredentials(profileName, config).pipe(
        Effect.tap((creds) => {
          const sourceStr = creds.source.details
            ? `${creds.source.type} - ${creds.source.details}`
            : creds.source.type;
          return Effect.all([
            Console.log(`  apiKey: ${displayRedacted(creds.apiKey, 10)}`),
            Console.log(`  apiBaseUrl: ${creds.apiBaseUrl}`),
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
