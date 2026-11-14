import * as auth from "@distilled.cloud/e2b/auth";
import { credentials as e2bCredentials, DEFAULT_DOMAIN } from "@distilled.cloud/e2b/Credentials";
import {
  AuthError,
  AuthProviderLayer,
  NeedsReauth,
  refreshHint,
  type ConfigureField,
  type ConfigureMethod,
  type ProviderDetails,
} from "alchemy/Auth/AuthProvider";
import { browserOAuth } from "alchemy/Auth/BrowserOAuth";
import { displayRedacted } from "alchemy/Auth/Credentials";
import { getEnv, getEnvRedacted, mapPromptCancellation } from "alchemy/Auth/Env";
import { withProfileCredentialsLock } from "alchemy/Auth/Lock";
import {
  collectFieldValues,
  storedSecret,
  storedValueText,
  validateFieldValues,
  type StoredValues,
} from "alchemy/Auth/StoredAuthProvider";
import * as Interaction from "alchemy/Interaction";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  grantFromUrl,
  refreshGrant,
  revokeGrant,
  startLogin,
  type E2BGrant,
} from "./internal/Login.ts";

export const E2B_AUTH_PROVIDER_NAME = "E2B";

/**
 * A profile's E2B values: an OAuth grant from the browser login (`oauth`),
 * or a pasted access token or API key (`stored`).
 */
export const E2BAuthConfigSchema = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("oauth"),
    email: Schema.String,
    teamId: Schema.String,
    teamName: Schema.String,
    clientId: Schema.String,
    tokenEndpoint: Schema.String,
    revokeEndpoint: Schema.String,
    access: Schema.String,
    refresh: Schema.String,
    expires: Schema.Number,
    domain: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    method: Schema.Literal("stored"),
    accessToken: Schema.optional(Schema.String),
    teamId: Schema.optional(Schema.String),
    apiKey: Schema.optional(Schema.String),
    domain: Schema.optional(Schema.String),
  }),
]);
export type E2BAuthConfig = typeof E2BAuthConfigSchema.Type;
type OAuthConfig = Extract<E2BAuthConfig, { method: "oauth" }>;

/**
 * Resolved E2B credentials.
 *
 * `accessToken` reaches every control-plane endpoint, and it is the only
 * credential that can mint API keys, which bindings and `E2B.ApiKey` need.
 * `teamId` is looked up from the token when unset. `apiKey` is a team API
 * key: enough for resources, not for bindings. `expires` is set for an
 * OAuth access token, so it is refreshed before it lapses.
 */
export interface E2BResolvedCredentials {
  readonly apiKey: Redacted.Redacted<string> | undefined;
  readonly accessToken: Redacted.Redacted<string> | undefined;
  readonly teamId: string | undefined;
  readonly domain: string;
  readonly expires?: number;
  readonly source: { readonly type: E2BAuthConfig["method"] | "env"; readonly details?: string };
}

const storedFields: ReadonlyArray<ConfigureField> = [
  {
    name: "accessToken",
    label: "E2B access token",
    description: "Reaches every endpoint and mints the API keys bindings need.",
    secret: true,
    optional: true,
  },
  { name: "teamId", label: "E2B team id, if not your default team", optional: true },
  {
    name: "apiKey",
    label: "E2B API key (e2b_…)",
    description: "Only without an access token: enough for resources, not for bindings.",
    secret: true,
    optional: true,
  },
  { name: "domain", label: "E2B domain", optional: true, placeholder: DEFAULT_DOMAIN },
];

const storedConfig = (values: StoredValues): E2BAuthConfig => ({
  method: "stored",
  ...Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => {
      const text = storedValueText(value);
      return text === undefined ? [] : [[key, text]];
    }),
  ),
});

const grantOf = (config: OAuthConfig): E2BGrant => ({
  email: config.email,
  access: Redacted.make(config.access),
  refresh: Redacted.make(config.refresh),
  tokenEndpoint: config.tokenEndpoint,
  revokeEndpoint: config.revokeEndpoint,
  clientId: config.clientId,
  expires: config.expires,
});

const withGrant = (config: OAuthConfig, grant: E2BGrant): OAuthConfig => ({
  ...config,
  access: Redacted.value(grant.access),
  refresh: Redacted.value(grant.refresh),
  expires: grant.expires,
});

/** The team the token acts on: its default team, as `e2b auth login` picks it. */
const defaultTeam = (access: Redacted.Redacted<string>, domain: string) =>
  auth.listTeams({}).pipe(
    Effect.provide(
      Layer.mergeAll(e2bCredentials({ accessToken: access, domain }), FetchHttpClient.layer),
    ),
    Effect.flatMap((teams) => {
      const team = teams.find((t) => t.isDefault) ?? (teams.length === 1 ? teams[0] : undefined);
      return team === undefined
        ? Effect.fail(AuthError.make({ message: "E2B: the account has no default team" }))
        : Effect.succeed(team);
    }),
    Effect.mapError((cause) =>
      cause._tag === "AuthError"
        ? cause
        : AuthError.make({ message: "E2B: could not list the account's teams", cause }),
    ),
  );

const readEnvironment = Effect.gen(function* () {
  const apiKey = yield* getEnvRedacted("E2B_API_KEY");
  const accessToken = yield* getEnvRedacted("E2B_ACCESS_TOKEN");
  if (!apiKey && !accessToken) {
    return yield* AuthError.make({
      message:
        "E2B CI credentials not found. Set E2B_ACCESS_TOKEN (or E2B_API_KEY for resources only).",
    });
  }
  return {
    apiKey,
    accessToken,
    teamId: yield* getEnv("E2B_TEAM_ID"),
    domain: (yield* getEnv("E2B_DOMAIN")) ?? DEFAULT_DOMAIN,
    source: { type: "env" as const },
  } satisfies E2BResolvedCredentials;
});

/**
 * Layer that registers the E2B {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Included in `E2B.providers()`
 * so `alchemy profile edit --add E2B` can configure it.
 *
 * Methods:
 * - `oauth`: E2B's browser login, the one `e2b auth login` runs; the access
 *   token refreshes itself.
 * - `stored`: a pasted access token or API key.
 */
export const E2BAuth = AuthProviderLayer<E2BAuthConfig, E2BResolvedCredentials>()(
  E2B_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const browserLogin = Effect.fn(function* (domain: string) {
      const grant = yield* Effect.scoped(
        Effect.gen(function* () {
          const login = yield* startLogin(domain);
          return yield* browserOAuth({
            provider: "E2B",
            url: login.url,
            callback: login.grant,
            exchange: grantFromUrl,
          });
        }),
      );
      const team = yield* defaultTeam(grant.access, domain);
      yield* Interaction.success(`E2B: logged in as ${grant.email} (team ${team.name}).`);
      return {
        method: "oauth" as const,
        email: grant.email,
        teamId: team.teamID,
        teamName: team.name,
        clientId: grant.clientId,
        tokenEndpoint: grant.tokenEndpoint,
        revokeEndpoint: grant.revokeEndpoint,
        access: Redacted.value(grant.access),
        refresh: Redacted.value(grant.refresh),
        expires: grant.expires,
        ...(domain === DEFAULT_DOMAIN ? {} : { domain }),
      } satisfies OAuthConfig;
    });

    const configure = (_profileName: string) =>
      Interaction.select({
        message: "E2B authentication method",
        options: [
          {
            value: "oauth" as const,
            label: "Browser login",
            description: "recommended — sign in to E2B; the token refreshes itself",
          },
          {
            value: "stored" as const,
            label: "Access token or API key",
            description: "paste a token and store it in the profile",
          },
        ],
      }).pipe(
        mapPromptCancellation,
        Effect.flatMap((method) =>
          method === "oauth"
            ? browserLogin(DEFAULT_DOMAIN)
            : collectFieldValues(storedFields).pipe(
                Effect.map(storedConfig),
                Effect.tap(() => Interaction.success("E2B: credentials saved.")),
              ),
        ),
        Effect.mapError((cause) =>
          cause._tag === "AuthError"
            ? cause
            : AuthError.make({
                message: `E2B: failed to configure credentials: ${cause.message}`,
                cause,
              }),
        ),
      );

    const configureMethods: ReadonlyArray<ConfigureMethod> = [
      { method: "oauth", fields: [] },
      { method: "stored", fields: storedFields },
    ];

    const configureWith = (
      _profileName: string,
      input: { readonly method: string; readonly values: Record<string, string> },
    ) =>
      input.method === "oauth"
        ? browserLogin(DEFAULT_DOMAIN).pipe(
            Effect.mapError((cause) =>
              cause._tag === "AuthError"
                ? cause
                : AuthError.make({ message: `E2B: browser login failed: ${cause.message}`, cause }),
            ),
          )
        : input.method === "stored"
          ? validateFieldValues(E2B_AUTH_PROVIDER_NAME, storedFields, input.values).pipe(
              Effect.map(storedConfig),
              Effect.tap(() => Interaction.success("E2B: credentials saved.")),
            )
          : Effect.fail(
              AuthError.make({
                message: `E2B: unknown method '${input.method}'. Valid methods: oauth, stored.`,
              }),
            );

    /** Refreshes an OAuth grant that is within a minute of expiring. */
    const freshGrant = Effect.fn(function* (profileName: string, config: OAuthConfig) {
      const now = yield* Clock.currentTimeMillis;
      if (config.expires > now + 60_000) return config;
      return withGrant(
        config,
        yield* refreshGrant(grantOf(config)).pipe(
          Effect.mapError((cause) =>
            NeedsReauth.make({
              provider: E2B_AUTH_PROVIDER_NAME,
              profile: profileName,
              message: `E2B login expired. ${refreshHint(E2B_AUTH_PROVIDER_NAME, profileName)}`,
              cause,
            }),
          ),
        ),
      );
    });

    const read = (
      profileName: string,
      config: E2BAuthConfig,
      updateConfig?: (config: E2BAuthConfig) => Effect.Effect<void, AuthError>,
    ): Effect.Effect<E2BResolvedCredentials, AuthError | NeedsReauth> =>
      Match.value(config).pipe(
        Match.when({ method: "stored" }, (stored) =>
          Effect.succeed({
            apiKey: storedSecret(stored.apiKey),
            accessToken: storedSecret(stored.accessToken),
            teamId: stored.teamId,
            domain: stored.domain ?? DEFAULT_DOMAIN,
            source: { type: "stored" as const },
          } satisfies E2BResolvedCredentials),
        ),
        Match.when({ method: "oauth" }, (oauth) =>
          Effect.gen(function* () {
            const fresh = yield* freshGrant(profileName, oauth);
            if (fresh !== oauth) yield* updateConfig?.(fresh) ?? Effect.void;
            return {
              apiKey: undefined,
              accessToken: Redacted.make(fresh.access),
              teamId: fresh.teamId,
              domain: fresh.domain ?? DEFAULT_DOMAIN,
              expires: fresh.expires,
              source: { type: "oauth" as const, details: fresh.email },
            } satisfies E2BResolvedCredentials;
          }),
        ),
        Match.exhaustive,
      );

    const login = (
      profileName: string,
      config: E2BAuthConfig,
      updateConfig?: (config: E2BAuthConfig) => Effect.Effect<void, AuthError>,
      reload?: Effect.Effect<E2BAuthConfig, AuthError>,
    ) =>
      Match.value(config).pipe(
        Match.when({ method: "stored" }, (stored) => Effect.succeed(stored)),
        Match.when({ method: "oauth" }, (oauth) =>
          // Refresh tokens can be single-use: refresh the one stored now,
          // under the lock; a refused refresh falls back to the browser.
          withProfileCredentialsLock(
            profileName,
            Effect.gen(function* () {
              const current = yield* reload ?? Effect.succeed(oauth);
              if (current.method !== "oauth") return current;
              const refreshed = withGrant(current, yield* refreshGrant(grantOf(current)));
              if (updateConfig === undefined) return refreshed;
              yield* updateConfig(refreshed);
              return undefined;
            }),
          ).pipe(
            Effect.catchTag("E2BLoginError", () => browserLogin(oauth.domain ?? DEFAULT_DOMAIN)),
          ),
        ),
        Match.exhaustive,
        Effect.mapError((cause) =>
          cause._tag === "AuthError"
            ? cause
            : AuthError.make({ message: `E2B: login failed: ${cause.message}`, cause }),
        ),
      );

    const logout = (_profileName: string, config: E2BAuthConfig) =>
      config.method === "oauth" ? revokeGrant(grantOf(config)) : Effect.void;

    const details = (
      profileName: string,
      config: E2BAuthConfig,
      updateConfig?: (config: E2BAuthConfig) => Effect.Effect<void, AuthError>,
    ) =>
      Effect.all([read(profileName, config, updateConfig), Clock.currentTimeMillis]).pipe(
        Effect.map(([creds, now]): ProviderDetails => {
          const lines: Array<{ key: string; value: string }> = [];
          if (config.method === "oauth") lines.push({ key: "email", value: config.email });
          if (creds.accessToken) {
            lines.push({ key: "accessToken", value: displayRedacted(creds.accessToken) });
          }
          if (creds.expires !== undefined) {
            const remaining = creds.expires - now;
            lines.push({
              key: "expires",
              value:
                remaining <= 0
                  ? "expired"
                  : `in ${Duration.format(Duration.millis(remaining))} (refreshes itself)`,
            });
          }
          if (creds.apiKey) lines.push({ key: "apiKey", value: displayRedacted(creds.apiKey) });
          lines.push({
            key: "team",
            value:
              config.method === "oauth"
                ? `${config.teamName} (${config.teamId})`
                : (creds.teamId ?? "default"),
          });
          lines.push({ key: "source", value: creds.source.type });
          return { lines };
        }),
      );

    return {
      configSchema: E2BAuthConfigSchema,
      configure,
      configureWith,
      configureMethods,
      login,
      logout,
      details,
      read,
      readEnvironment,
      environment: [
        {
          name: "E2B_ACCESS_TOKEN",
          required: false,
          secret: true,
          description:
            "Access token. Reaches every endpoint and mints the API keys bindings and E2B.ApiKey need.",
        },
        {
          name: "E2B_TEAM_ID",
          required: false,
          description: "Team id sent with the access token. Defaults to the token's default team.",
        },
        {
          name: "E2B_API_KEY",
          required: false,
          secret: true,
          description:
            "Team API key, sent as X-API-Key. Enough for resources; bindings need the access token.",
        },
        {
          name: "E2B_DOMAIN",
          required: false,
          description: "E2B domain for self-hosted deployments.",
        },
      ],
    };
  }),
);
