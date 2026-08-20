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

export const STRIPE_AUTH_PROVIDER_NAME = "Stripe";

export type StripeAuthConfig = { method: "env" } | { method: "stored" };

export type StripeStoredCredentials = {
  type: "apiKey";
  apiKey: string;
};

export type StripeResolvedCredentials = {
  type: "apiKey";
  apiKey: Redacted.Redacted<string>;
  source: { type: StripeAuthConfig["method"]; details?: string };
};

const options: Array<{
  value: StripeAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
  {
    value: "env",
    label: "Environment Variable",
    hint: "STRIPE_API_KEY",
  },
  {
    value: "stored",
    label: "API Key",
    hint: "enter interactively, stored in ~/.alchemy/credentials",
  },
];

/**
 * Layer that registers the Stripe {@link AuthProvider} into the
 * {@link AuthProviders} registry.
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
        message: "Stripe API Key",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      yield* store.write<StripeStoredCredentials>(
        profileName,
        "stripe-stored",
        {
          type: "apiKey",
          apiKey,
        },
      );
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
            const apiKey = yield* getEnvRedacted("STRIPE_API_KEY");
            if (!apiKey) {
              return yield* new AuthError({
                message:
                  "Stripe env credentials not found. Set STRIPE_API_KEY.",
              });
            }
            return {
              type: "apiKey" as const,
              apiKey,
              source: { type: "env" as const },
            };
          }),
        ),
        Match.when({ method: "stored" }, () =>
          store
            .read<StripeStoredCredentials>(profileName, "stripe-stored")
            .pipe(
              Effect.flatMap((creds) =>
                creds == null
                  ? Effect.fail(
                      new AuthError({
                        message:
                          "Stripe stored credentials not found. Run: alchemy login --configure",
                      }),
                    )
                  : Effect.succeed({
                      type: "apiKey" as const,
                      apiKey: Redacted.make(creds.apiKey),
                      source: { type: "stored" as const },
                    }),
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
            .delete(profileName, "stripe-stored")
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
            // If STRIPE_API_KEY isn't set, fall through to the interactive picker
            // so the user can switch to `stored` (or be told to set the env var)
            // instead of silently failing later in `read`. The new selection is
            // persisted to the profile so subsequent logins don't re-prompt.
            getEnvRedacted("STRIPE_API_KEY").pipe(
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
              .read<StripeStoredCredentials>(profileName, "stripe-stored")
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
            Console.log(`  apiKey: ${displayRedacted(creds.apiKey, 9)}`),
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
