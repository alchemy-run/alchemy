import * as railway from "@distilled.cloud/railway";
import { DEFAULT_API_BASE_URL } from "@distilled.cloud/railway";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import * as Os from "node:os";
import {
  AuthError,
  AuthProviderLayer,
  NeedsReauth,
  refreshHint,
  type ConfigureField,
  type ConfigureMethod,
  type ProviderDetails,
} from "../Auth/AuthProvider.ts";
import { CredentialsStore, displayRedacted } from "../Auth/Credentials.ts";
import {
  getEnv,
  getEnvRedacted,
  getEnvRedactedRequired,
  mapPromptCancellation,
} from "../Auth/Env.ts";
import {
  storedSecret,
  storedValueText,
  validateFieldValues,
} from "../Auth/StoredAuthProvider.ts";
import * as CliKit from "../Cli/CliKit/index.ts";
import {
  loginSessionUrl,
  pollLoginSessionToken,
  provideAnonymousRailway,
} from "./LoginSession.ts";

export const RAILWAY_AUTH_PROVIDER_NAME = "Railway";
export const RAILWAY_API_TOKEN_ENV = "RAILWAY_API_TOKEN";
export const RAILWAY_API_URL_ENV = "RAILWAY_API_URL";

const STORAGE_KEY = "railway-stored";
const OAUTH_STORAGE_KEY = "railway-oauth";

/** Manifest-entry schema for Railway authentication. */
export const RailwayAuthConfigSchema = Schema.Union([
  Schema.Struct({ method: Schema.Literal("env") }),
  Schema.Struct({ method: Schema.Literal("stored") }),
  Schema.Struct({ method: Schema.Literal("oauth") }),
]);
export type RailwayAuthConfig = typeof RailwayAuthConfigSchema.Type;

/**
 * Token credentials persisted to disk for `method: "stored"` and
 * `method: "oauth"`. The JSON shape (`token` as a plain string) is
 * unchanged from the pre-schema store, so existing credential files decode.
 */
export const RailwayStoredCredentials = Schema.Struct({
  type: Schema.Literal("token"),
  token: Schema.RedactedFromValue(Schema.String),
  apiBaseUrl: Schema.optional(Schema.String),
});
export type RailwayStoredCredentials = typeof RailwayStoredCredentials.Type;

export type RailwayResolvedCredentials = {
  type: "token";
  token: Redacted.Redacted<string>;
  tokenKind: "account";
  apiBaseUrl: string;
  source: { type: RailwayAuthConfig["method"]; details?: string };
};

const options: Array<{
  value: RailwayAuthConfig["method"];
  label: string;
  description?: string;
}> = [
  {
    value: "oauth",
    label: "OAuth (CLI login session)",
    description:
      "recommended — open railway.com/cli-login, confirm the pairing code",
  },
  {
    value: "env",
    label: "Environment Variables",
    description: `${RAILWAY_API_TOKEN_ENV} + optional ${RAILWAY_API_URL_ENV}`,
  },
  {
    value: "stored",
    label: "API Token",
    description: "enter interactively, stored in ~/.alchemy/credentials",
  },
];

const normalizeApiBaseUrl = (explicit?: string) => {
  const trimmed = (explicit ?? "").trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : DEFAULT_API_BASE_URL;
};

const resolveApiBaseUrl = (explicit?: string) =>
  getEnv(RAILWAY_API_URL_ENV).pipe(
    Effect.map((fromEnv) => normalizeApiBaseUrl(explicit ?? fromEnv)),
  );

/**
 * Layer that registers the Railway {@link AuthProvider} into the
 * {@link AuthProviders} registry. Include this in the Railway `providers()`
 * layer so the alchemy CLI can discover it.
 *
 * Supported methods:
 * - `env`: reads `RAILWAY_API_TOKEN` (account Bearer). Project tokens are
 *   not used — they cannot reach workspace-wide operations.
 * - `stored`: prompts for an API token and writes it to
 *   `~/.alchemy/credentials/<profile>/railway-stored.json`.
 * - `oauth`: CLI login session (`loginSessionCreate` → open the pairing URL →
 *   poll `loginSessionVerify` / `loginSessionConsume` → store the token).
 *   Does not require a pre-existing token. An optional `RAILWAY_API_URL`
 *   overrides the backboard host (default `https://backboard.railway.com`).
 */
export const RailwayAuth = AuthProviderLayer<
  RailwayAuthConfig,
  RailwayResolvedCredentials
>()(
  RAILWAY_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const prompt = CliKit.accessors;
    const store = yield* CredentialsStore;

    const loginStored = Effect.fn(function* (profileName: string) {
      const token = yield* prompt.prompt
        .password({
          message: "Railway API Token",
          validate: (v) => (v.length === 0 ? "Required" : undefined),
        })
        .pipe(mapPromptCancellation, Effect.map(Redacted.make));

      const envUrl = yield* getEnv(RAILWAY_API_URL_ENV);
      const urlPrompt = yield* prompt.prompt
        .text({
          message: "Railway API URL (Enter for default)",
          placeholder: DEFAULT_API_BASE_URL,
          defaultValue: envUrl ?? DEFAULT_API_BASE_URL,
        })
        .pipe(mapPromptCancellation);
      const trimmed = (urlPrompt ?? "").trim();
      const apiBaseUrl =
        trimmed.length > 0 && trimmed !== DEFAULT_API_BASE_URL
          ? trimmed
          : undefined;

      yield* store.write(profileName, STORAGE_KEY, RailwayStoredCredentials, {
        type: "token",
        token,
        apiBaseUrl,
      });
      yield* prompt.output.success("Railway: credentials saved.");
      return { method: "stored" as const };
    });

    const loginOAuth = Effect.fn(function* (profileName: string) {
      const apiBaseUrl = yield* resolveApiBaseUrl();
      const hostname = yield* Effect.sync(() => {
        try {
          return Os.hostname();
        } catch {
          return "alchemy";
        }
      });

      const withAnonymous = <A, E>(
        effect: Effect.Effect<A, E, railway.RailwayOpContext>,
      ) => provideAnonymousRailway(effect, apiBaseUrl);

      const code = yield* withAnonymous(railway.loginSessionCreate({})).pipe(
        Effect.mapError(
          (e) =>
            new AuthError({
              message: "Railway login session create failed",
              cause: e,
            }),
        ),
      );

      const url = loginSessionUrl(code, { hostname });
      // `awaitExternal` is only on the CliKit service, not the `accessors`
      // helper (same acquisition as BrowserOAuth / the AWS SSO flow).
      const cli = yield* CliKit.CliKit;
      const services = yield* Effect.context<ChildProcessSpawner>();
      // Invoked later by the prompt's keyboard event boundary, not while the
      // surrounding Effect is executing.
      const runOpenUrl = Effect.runPromiseWith(services);
      const openFailed = yield* CliKit.openUrl(url).pipe(
        Effect.as(false),
        Effect.catch(() => Effect.succeed(true)),
      );

      const cancel = withAnonymous(railway.loginSessionCancel({ code })).pipe(
        Effect.catch(() => Effect.void),
      );

      // The token only ever arrives through the poll; the awaitExternal
      // prompt renders the pairing URL + code and re-opens the browser on
      // demand, so it must never win the race — park it after it returns.
      const token = yield* withAnonymous(pollLoginSessionToken(code)).pipe(
        Effect.raceFirst(
          cli.prompt
            .awaitExternal({
              message: "Railway authorization",
              waitingLabel:
                "waiting for browser authorization (up to 5 minutes)…",
              url,
              code,
              openFailed,
              onOpen: () => runOpenUrl(CliKit.openUrl(url)),
              allowManualInput: false,
            })
            .pipe(mapPromptCancellation, Effect.andThen(Effect.never)),
        ),
        Effect.onInterrupt(() => cancel),
        Effect.tapError(() => cancel),
        Effect.mapError((e) =>
          e instanceof AuthError
            ? e
            : new AuthError({
                message: "Railway login session poll failed",
                cause: e,
              }),
        ),
      );

      if (token == null || token.length === 0) {
        yield* cancel;
        return yield* new AuthError({
          message: "Railway login session timed out after 5 minutes.",
        });
      }

      yield* store.write(
        profileName,
        OAUTH_STORAGE_KEY,
        RailwayStoredCredentials,
        {
          type: "token",
          token: Redacted.make(token),
          apiBaseUrl:
            apiBaseUrl === DEFAULT_API_BASE_URL ? undefined : apiBaseUrl,
        },
      );
      yield* prompt.output.success("Railway: OAuth credentials saved.");
      return { method: "oauth" as const };
    });

    const configureInteractive = (profileName: string) =>
      prompt.prompt
        .select({
          message: "Railway authentication method",
          options,
        })
        .pipe(
          Effect.flatMap((method) =>
            Match.value(method).pipe(
              Match.when("env", () =>
                Effect.gen(function* () {
                  const token = yield* getEnvRedacted(RAILWAY_API_TOKEN_ENV);
                  if (!token) {
                    yield* prompt.output.warning(
                      `Railway: ${RAILWAY_API_TOKEN_ENV} is not currently set — export it before deploying.`,
                    );
                  }
                  return { method: "env" as const };
                }),
              ),
              Match.when("stored", () => loginStored(profileName)),
              Match.when("oauth", () => loginOAuth(profileName)),
              Match.exhaustive,
            ),
          ),
        );

    const configureCredentials = (profileName: string) =>
      configureInteractive(profileName).pipe(
        Effect.mapError(
          (e) =>
            new AuthError({
              message: "failed to configure credentials",
              cause: e,
            }),
        ),
      );

    /**
     * Flag-driven (`--method token --set ...` / `--method env`) fields,
     * mirroring the interactive prompts. OAuth requires a browser and stays
     * interactive-only, so it is deliberately absent.
     */
    const tokenFields: ReadonlyArray<ConfigureField> = [
      { name: "token", label: "Railway API Token", secret: true },
      {
        name: "apiBaseUrl",
        label: "Railway API URL",
        placeholder: DEFAULT_API_BASE_URL,
        optional: true,
      },
    ];

    const configureMethods: ReadonlyArray<ConfigureMethod> = [
      { method: "token", fields: tokenFields },
      { method: "env", fields: [] },
    ];

    const configureWith = (
      profileName: string,
      input: {
        readonly method: string;
        readonly values: Record<string, string>;
      },
    ): Effect.Effect<RailwayAuthConfig, AuthError, CliKit.CliKit> =>
      input.method === "token"
        ? validateFieldValues(
            RAILWAY_AUTH_PROVIDER_NAME,
            tokenFields,
            input.values,
          ).pipe(
            Effect.flatMap((values) =>
              store.write(profileName, STORAGE_KEY, RailwayStoredCredentials, {
                type: "token",
                token: storedSecret(values.token) ?? Redacted.make(""),
                apiBaseUrl: storedValueText(values.apiBaseUrl),
              }),
            ),
            Effect.andThen(
              prompt.output.success("Railway: credentials saved."),
            ),
            Effect.as({ method: "stored" as const }),
          )
        : input.method === "env"
          ? Effect.succeed({ method: "env" as const })
          : Effect.fail(
              new AuthError({
                message: `Railway: unknown method '${input.method}'. Only 'token' and 'env' are supported (OAuth is interactive-only).`,
              }),
            );

    const readStoredToken = (
      profileName: string,
      key: string,
      sourceType: "stored" | "oauth",
      missingMessage: string,
    ): Effect.Effect<RailwayResolvedCredentials, AuthError | NeedsReauth> =>
      Effect.gen(function* () {
        const creds = yield* store.read(
          profileName,
          key,
          RailwayStoredCredentials,
        );
        if (creds == null) {
          return yield* new NeedsReauth({
            provider: RAILWAY_AUTH_PROVIDER_NAME,
            profile: profileName,
            message: missingMessage,
          });
        }
        const apiBaseUrl = yield* resolveApiBaseUrl(creds.apiBaseUrl);
        return {
          type: "token" as const,
          token: creds.token,
          tokenKind: "account" as const,
          apiBaseUrl,
          source: { type: sourceType },
        };
      });

    const resolveCredentials = (
      profileName: string,
      config: RailwayAuthConfig,
    ): Effect.Effect<RailwayResolvedCredentials, AuthError | NeedsReauth> =>
      Effect.gen(function* () {
        const reauth = refreshHint(RAILWAY_AUTH_PROVIDER_NAME, profileName);
        return yield* Match.value(config).pipe(
          Match.when(
            { method: "env" },
            Effect.fn(function* () {
              const token = yield* getEnvRedacted(RAILWAY_API_TOKEN_ENV);
              if (!token) {
                return yield* new AuthError({
                  message: `Railway env credentials not found. Set ${RAILWAY_API_TOKEN_ENV}.`,
                });
              }
              const apiBaseUrl = yield* resolveApiBaseUrl();
              return {
                type: "token" as const,
                token,
                tokenKind: "account" as const,
                apiBaseUrl,
                source: {
                  type: "env" as const,
                  details: RAILWAY_API_TOKEN_ENV,
                },
              } satisfies RailwayResolvedCredentials;
            }),
          ),
          Match.when({ method: "stored" }, () =>
            readStoredToken(
              profileName,
              STORAGE_KEY,
              "stored",
              `Railway stored credentials not found. ${reauth}`,
            ),
          ),
          Match.when({ method: "oauth" }, () =>
            readStoredToken(
              profileName,
              OAUTH_STORAGE_KEY,
              "oauth",
              `Railway OAuth credentials not found. ${reauth}`,
            ),
          ),
          Match.exhaustive,
        );
      });

    const logout = (profileName: string, config: RailwayAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, STORAGE_KEY)
            .pipe(
              Effect.andThen(
                prompt.output.success("Railway: stored credentials removed"),
              ),
            ),
        ),
        // Railway account tokens have no revocation endpoint for CLI-session
        // tokens, so logout just drops the locally stored token.
        Match.when({ method: "oauth" }, () =>
          store
            .delete(profileName, OAUTH_STORAGE_KEY)
            .pipe(
              Effect.andThen(
                prompt.output.success("Railway: OAuth credentials removed"),
              ),
            ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: RailwayAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "env" }, () =>
            getEnvRedacted(RAILWAY_API_TOKEN_ENV).pipe(
              Effect.flatMap((token) =>
                token
                  ? Effect.void
                  : Effect.fail(
                      new AuthError({
                        message:
                          `Railway: ${RAILWAY_API_TOKEN_ENV} is not set. Export it, or run ` +
                          `\`alchemy profile edit --profile ${profileName} --reconfigure ${RAILWAY_AUTH_PROVIDER_NAME}\` to switch methods.`,
                      }),
                    ),
              ),
            ),
          ),
          // Railway account tokens neither expire nor refresh, so login only
          // (re-)prompts when no credential is stored yet.
          Match.when({ method: "stored" }, () =>
            store
              .read(profileName, STORAGE_KEY, RailwayStoredCredentials)
              .pipe(
                Effect.flatMap((creds) =>
                  creds == null
                    ? loginStored(profileName).pipe(Effect.asVoid)
                    : Effect.void,
                ),
              ),
          ),
          Match.when({ method: "oauth" }, () =>
            store
              .read(profileName, OAUTH_STORAGE_KEY, RailwayStoredCredentials)
              .pipe(
                Effect.flatMap((creds) =>
                  creds == null
                    ? loginOAuth(profileName).pipe(Effect.asVoid)
                    : Effect.void,
                ),
              ),
          ),
          Match.exhaustive,
        )
        .pipe(
          Effect.mapError((e) =>
            e instanceof AuthError
              ? e
              : new AuthError({ message: "login failed", cause: e }),
          ),
        );

    const details = (
      profileName: string,
      config: RailwayAuthConfig,
    ): Effect.Effect<ProviderDetails, AuthError | NeedsReauth> =>
      resolveCredentials(profileName, config).pipe(
        Effect.map((creds) => ({
          lines: [
            { key: "token", value: displayRedacted(creds.token, 6) },
            { key: "tokenKind", value: creds.tokenKind },
            { key: "apiBaseUrl", value: creds.apiBaseUrl },
            {
              key: "source",
              value: creds.source.details
                ? `${creds.source.type} - ${creds.source.details}`
                : creds.source.type,
            },
          ],
        })),
      );

    const readEnvironment = Effect.gen(function* () {
      const token = yield* getEnvRedactedRequired(RAILWAY_API_TOKEN_ENV);
      const apiBaseUrl = yield* resolveApiBaseUrl();
      return {
        type: "token" as const,
        token,
        tokenKind: "account" as const,
        apiBaseUrl,
        source: { type: "env" as const, details: RAILWAY_API_TOKEN_ENV },
      } satisfies RailwayResolvedCredentials;
    });

    return {
      configSchema: RailwayAuthConfigSchema,
      configure: configureCredentials,
      configureWith,
      configureMethods,
      logout,
      login,
      details,
      read: resolveCredentials,
      readEnvironment,
      environment: [
        {
          name: RAILWAY_API_TOKEN_ENV,
          required: true,
          secret: true,
          description: "Account API token (Bearer).",
        },
        {
          name: RAILWAY_API_URL_ENV,
          required: false,
          description: "Backboard API base URL override.",
        },
      ],
    };
  }),
);
