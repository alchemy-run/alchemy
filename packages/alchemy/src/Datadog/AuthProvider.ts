import { DEFAULT_SITE } from "@distilled.cloud/datadog/Credentials";
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
import * as Clank from "../Util/Clank.ts";

const STORAGE_KEY = "datadog-stored";

const options: Array<{
  value: DatadogAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
  {
    value: "env",
    label: "Environment Variables",
    hint: "DD_API_KEY + DD_APP_KEY + optional DD_SITE",
  },
  {
    value: "stored",
    label: "API Key + Application Key",
    hint: "enter credentials interactively, stored in ~/.alchemy/credentials",
  },
];

export type DatadogAuthConfig = { method: "env" } | { method: "stored" };

export interface DatadogStoredCredentials {
  apiKey: string;
  appKey: string;
  /** Datadog site (e.g. `datadoghq.com`, `us5.datadoghq.com`, `datadoghq.eu`). */
  site?: string;
}

export interface DatadogResolvedCredentials {
  apiKey: Redacted.Redacted<string>;
  appKey: Redacted.Redacted<string>;
  site: string;
  source: { type: DatadogAuthConfig["method"]; details?: string };
}

export const DATADOG_AUTH_PROVIDER_NAME = "Datadog";

/**
 * Layer that registers the Datadog {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Include this in the Datadog
 * `providers()` layer so `alchemy login` can discover it.
 */
export const DatadogAuth = AuthProviderLayer<
  DatadogAuthConfig,
  DatadogResolvedCredentials
>()(
  DATADOG_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const store = yield* CredentialsStore;

    const loginStored = Effect.fn(function* (profileName: string) {
      const apiKey = yield* Clank.password({
        message: "Datadog API Key",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);
      const appKey = yield* Clank.password({
        message: "Datadog Application Key",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);
      const envSite = yield* getEnv("DD_SITE");
      const sitePrompt = yield* Clank.text({
        message: "Datadog site (Enter for default)",
        placeholder: envSite ?? DEFAULT_SITE,
        defaultValue: envSite ?? DEFAULT_SITE,
      }).pipe(retryOnce);
      const site =
        sitePrompt && sitePrompt.length > 0 && sitePrompt !== DEFAULT_SITE
          ? sitePrompt
          : undefined;

      yield* store.write<DatadogStoredCredentials>(profileName, STORAGE_KEY, {
        apiKey,
        appKey,
        site,
      });
      yield* Clank.success("Datadog: credentials saved.");
      return { method: "stored" as const };
    });

    const configureInteractive = (profileName: string) =>
      Clank.select({
        message: "Datadog authentication method",
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
      config: DatadogAuthConfig,
    ): Effect.Effect<DatadogResolvedCredentials, AuthError> =>
      Match.value(config).pipe(
        Match.when(
          { method: "env" },
          Effect.fn(function* () {
            const apiKey =
              (yield* getEnvRedacted("DD_API_KEY")) ??
              (yield* getEnvRedacted("DATADOG_API_KEY"));
            const appKey =
              (yield* getEnvRedacted("DD_APP_KEY")) ??
              (yield* getEnvRedacted("DATADOG_APP_KEY"));
            if (!apiKey || !appKey) {
              return yield* new AuthError({
                message:
                  "Datadog env credentials not found. Set DD_API_KEY and DD_APP_KEY.",
              });
            }
            const site =
              (yield* getEnv("DD_SITE")) ??
              (yield* getEnv("DATADOG_SITE")) ??
              DEFAULT_SITE;
            return {
              apiKey,
              appKey,
              site,
              source: { type: "env" as const },
            };
          }),
        ),
        Match.when({ method: "stored" }, () =>
          store.read<DatadogStoredCredentials>(profileName, STORAGE_KEY).pipe(
            Effect.flatMap((creds) =>
              creds == null
                ? Effect.fail(
                    new AuthError({
                      message:
                        "Datadog stored credentials not found. Run: alchemy login --configure",
                    }),
                  )
                : Effect.succeed({
                    apiKey: Redacted.make(creds.apiKey),
                    appKey: Redacted.make(creds.appKey),
                    site: creds.site ?? DEFAULT_SITE,
                    source: { type: "stored" as const },
                  }),
            ),
          ),
        ),
        Match.exhaustive,
      );

    const logout = (profileName: string, config: DatadogAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, STORAGE_KEY)
            .pipe(
              Effect.andThen(
                Clank.success("Datadog: stored credentials removed"),
              ),
            ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: DatadogAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "env" }, () => Effect.void),
          Match.when({ method: "stored" }, () =>
            store
              .read<DatadogStoredCredentials>(profileName, STORAGE_KEY)
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

    const prettyPrint = (profileName: string, config: DatadogAuthConfig) =>
      resolveCredentials(profileName, config).pipe(
        Effect.tap((creds) => {
          const sourceStr = creds.source.details
            ? `${creds.source.type} - ${creds.source.details}`
            : creds.source.type;
          return Effect.all([
            Console.log(`  apiKey: ${displayRedacted(creds.apiKey, 6)}`),
            Console.log(`  appKey: ${displayRedacted(creds.appKey, 6)}`),
            Console.log(`  site: ${creds.site}`),
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
