import { DEFAULT_API_BASE_URL, DEFAULT_CORE_BASE_URL } from "@distilled.cloud/entire/Credentials";
import {
  AuthError,
  AuthProviderLayer,
  NeedsReauth,
  refreshHint,
  type ProviderDetails,
} from "alchemy/Auth/AuthProvider";
import { deviceOAuth } from "alchemy/Auth/BrowserOAuth";
import { displayRedacted } from "alchemy/Auth/Credentials";
import { getEnv, getEnvRedacted } from "alchemy/Auth/Env";
import { withProfileCredentialsLock } from "alchemy/Auth/Lock";
import * as Interaction from "alchemy/Interaction";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as OAuthClient from "./OAuthClient.ts";

/**
 * Canonical name registered in {@link AuthProviders}. Use this key to look
 * up the Entire {@link AuthProvider} from inside provider Layers.
 */
export const ENTIRE_AUTH_PROVIDER_NAME = "Entire";

/**
 * Values stored in an Entire provider profile. Entire issues no long-lived
 * API keys, so the only stored method is an OAuth grant from the device
 * flow, refreshed with its refresh token.
 */
export const EntireAuthConfigSchema = Schema.Struct({
  method: Schema.Literal("oauth"),
  clientId: Schema.optional(Schema.String),
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Number,
  scopes: Schema.String.pipe(Schema.Array, Schema.mutable),
});
export type EntireAuthConfig = typeof EntireAuthConfigSchema.Type;

/**
 * Resolved in-memory Entire credentials returned by
 * {@link AuthProviderImpl.read}: a bearer access token plus the Core and
 * cell hosts it is used against.
 */
export interface EntireResolvedCredentials {
  readonly token: Redacted.Redacted<string>;
  /** Epoch ms; `undefined` for an `ENTIRE_TOKEN` whose expiry is unknown. */
  readonly expires: number | undefined;
  readonly coreBaseUrl: string;
  readonly apiBaseUrl: string;
  readonly source: { readonly type: "oauth" | "env"; readonly details?: string };
}

const baseUrls = Effect.gen(function* () {
  return {
    coreBaseUrl: (yield* getEnv("ENTIRE_CORE_BASE_URL")) ?? DEFAULT_CORE_BASE_URL,
    apiBaseUrl: (yield* getEnv("ENTIRE_API_BASE_URL")) ?? DEFAULT_API_BASE_URL,
  };
});

const toConfig = (credentials: OAuthClient.OAuthCredentials): EntireAuthConfig => ({
  method: "oauth",
  clientId: credentials.clientId,
  access: Redacted.value(credentials.access),
  refresh: Redacted.value(credentials.refresh),
  expires: credentials.expires,
  scopes: credentials.scopes,
});

const toCredentials = (config: EntireAuthConfig): OAuthClient.OAuthCredentials => ({
  type: "oauth",
  clientId: config.clientId,
  access: Redacted.make(config.access),
  refresh: Redacted.make(config.refresh),
  expires: config.expires,
  scopes: config.scopes,
});

/**
 * Layer that registers the Entire {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Include this in the Entire
 * `providers()` layer so the alchemy CLI can discover it.
 *
 * The only method is `oauth`: the device flow (RFC 8628) against Entire's
 * login server, the same grant `entire login --device` obtains. CI sets
 * `ENTIRE_TOKEN` instead.
 */
export const EntireAuth = AuthProviderLayer<EntireAuthConfig, EntireResolvedCredentials>()(
  ENTIRE_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const deviceLogin = Effect.gen(function* () {
      const authorization = yield* OAuthClient.deviceAuthorize(OAuthClient.OAUTH_SCOPES);
      const credentials = yield* deviceOAuth({
        provider: "Entire",
        authorization,
        token: OAuthClient.deviceToken(authorization),
      });
      yield* Interaction.success("Connected to Entire with OAuth.");
      return toConfig(credentials);
    }).pipe(
      Effect.mapError((cause) => AuthError.make({ message: "Entire: device login failed", cause })),
    );

    const configure = (_profileName: string) => deviceLogin;

    const configureWith = (
      _profileName: string,
      input: { readonly method: string; readonly values: Record<string, string> },
    ) =>
      input.method === "oauth"
        ? deviceLogin
        : Effect.fail(
            AuthError.make({
              message: `Entire: unknown method '${input.method}'. Valid methods: oauth.`,
            }),
          );

    const read = (
      profileName: string,
      config: EntireAuthConfig,
      updateConfig?: (config: EntireAuthConfig) => Effect.Effect<void, AuthError>,
    ) =>
      Effect.gen(function* () {
        const reauth = refreshHint(ENTIRE_AUTH_PROVIDER_NAME, profileName);
        const creds = toCredentials(config);
        if (!OAuthClient.usesCurrentClient(creds)) {
          return yield* NeedsReauth.make({
            provider: ENTIRE_AUTH_PROVIDER_NAME,
            profile: profileName,
            message: `Entire OAuth credentials for profile '${profileName}' were issued to another OAuth client. ${reauth}`,
          });
        }
        // Refresh when the token expires within a minute, and persist the
        // rotated grant so the next resolve reuses it.
        const now = yield* Clock.currentTimeMillis;
        const fresh =
          creds.expires > now + 60_000
            ? creds
            : yield* OAuthClient.refresh(creds).pipe(
                Effect.mapError((cause) =>
                  NeedsReauth.make({
                    provider: ENTIRE_AUTH_PROVIDER_NAME,
                    profile: profileName,
                    message: `Entire OAuth refresh failed. ${reauth}`,
                    cause,
                  }),
                ),
              );
        if (fresh !== creds) {
          yield* updateConfig?.(toConfig(fresh)) ?? Effect.void;
        }
        return {
          token: fresh.access,
          expires: fresh.expires,
          ...(yield* baseUrls),
          source: { type: "oauth" as const },
        } satisfies EntireResolvedCredentials;
      });

    const login = (
      profileName: string,
      config: EntireAuthConfig,
      updateConfig?: (config: EntireAuthConfig) => Effect.Effect<void, AuthError>,
    ) => {
      const credentials = toCredentials(config);
      if (!OAuthClient.usesCurrentClient(credentials)) return deviceLogin;
      return withProfileCredentialsLock(
        profileName,
        Interaction.info("Entire: refreshing OAuth credentials...").pipe(
          Effect.andThen(OAuthClient.refresh(credentials)),
          Effect.map(toConfig),
          Effect.tap((next) => updateConfig?.(next) ?? Effect.void),
          Effect.tap(() => Interaction.success("Entire: OAuth credentials refreshed.")),
        ),
      ).pipe(
        Effect.catchTag(
          ["OAuthError", "OAuthNetworkError", "OAuthServerUnavailable", "OAuthInvalidResponse"],
          () => deviceLogin,
        ),
        Effect.mapError((cause) => AuthError.make({ message: "Entire: login failed", cause })),
      );
    };

    const logout = (_profileName: string, config: EntireAuthConfig) =>
      OAuthClient.revoke(toCredentials(config)).pipe(Effect.ignore);

    const details = (
      profileName: string,
      config: EntireAuthConfig,
      updateConfig?: (config: EntireAuthConfig) => Effect.Effect<void, AuthError>,
    ) =>
      Effect.all([read(profileName, config, updateConfig), Clock.currentTimeMillis]).pipe(
        Effect.map(([creds, now]): ProviderDetails => {
          const expires =
            creds.expires === undefined
              ? "unknown"
              : creds.expires <= now
                ? `expired (${new Date(creds.expires).toISOString()})`
                : `in ${Duration.format(Duration.millis(creds.expires - now))} (${new Date(creds.expires).toISOString()})`;
          return {
            lines: [
              { key: "accessToken", value: displayRedacted(creds.token) },
              { key: "expires", value: expires },
              { key: "core", value: creds.coreBaseUrl },
              { key: "cell", value: creds.apiBaseUrl },
              { key: "source", value: creds.source.type },
            ],
          };
        }),
      );

    const readEnvironment = Effect.gen(function* () {
      const token = yield* getEnvRedacted("ENTIRE_TOKEN");
      if (token === undefined) {
        return yield* AuthError.make({
          message: "Entire CI credentials not found. Set ENTIRE_TOKEN.",
        });
      }
      return {
        token,
        expires: undefined,
        ...(yield* baseUrls),
        source: { type: "env" as const, details: "ENTIRE_TOKEN" },
      } satisfies EntireResolvedCredentials;
    });

    return {
      configSchema: EntireAuthConfigSchema,
      configure,
      configureWith,
      configureMethods: [{ method: "oauth", fields: [] }],
      logout,
      login,
      details,
      read,
      readEnvironment,
      environment: [
        {
          name: "ENTIRE_TOKEN",
          required: true,
          secret: true,
          description:
            "Bearer access token: `entire auth token`, or a service-account session minted by token exchange.",
        },
        {
          name: "ENTIRE_CORE_BASE_URL",
          required: false,
          description: `Core control-plane host. Defaults to ${DEFAULT_CORE_BASE_URL}.`,
        },
        {
          name: "ENTIRE_API_BASE_URL",
          required: false,
          description: `Cell data-plane host. Defaults to ${DEFAULT_API_BASE_URL}.`,
        },
      ],
    };
  }),
);
