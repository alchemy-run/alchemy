import { credentials, DEFAULT_API_BASE_URL } from "@distilled.cloud/daytona/Credentials";
import { listOrganizations } from "@distilled.cloud/daytona/organizations";
import {
  AuthError,
  AuthProviderLayer,
  NeedsReauth,
  refreshHint,
  type ConfigureField,
  type ConfigureMethod,
  type ProviderDetails,
} from "alchemy/Auth/AuthProvider";
import { deviceOAuth } from "alchemy/Auth/BrowserOAuth";
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
import * as OAuthClient from "./OAuthClient.ts";

export const DAYTONA_AUTH_PROVIDER_NAME = "Daytona";

/**
 * Values stored in a Daytona profile: an organization API key, or a user
 * session from `alchemy profile login` (Daytona's device login).
 */
export const DaytonaAuthConfigSchema = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("stored"),
    apiKey: Schema.String,
    apiBaseUrl: Schema.optional(Schema.String),
    organizationId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    method: Schema.Literal("oauth"),
    organizationId: Schema.String,
    apiBaseUrl: Schema.optional(Schema.String),
    clientId: Schema.optional(Schema.String),
    access: Schema.String,
    refresh: Schema.String,
    expires: Schema.Number,
    scopes: Schema.String.pipe(Schema.Array, Schema.mutable),
  }),
]);
export type DaytonaAuthConfig = typeof DaytonaAuthConfigSchema.Type;

/**
 * Resolved Daytona credentials: a bearer token and the API root. A user
 * session (`type: "oauth"`) can also manage the organization, its roles,
 * invitations and API keys, which Daytona refuses to organization API keys.
 */
export interface DaytonaResolvedCredentials {
  type: "apiKey" | "oauth";
  /** The organization API key, or the user's access token. */
  token: Redacted.Redacted<string>;
  apiBaseUrl: string;
  /** Sent as `X-Daytona-Organization-ID`; an API key already belongs to one organization. */
  organizationId?: string;
  /** When a user access token expires (epoch ms). */
  expires?: number;
  source: { type: DaytonaAuthConfig["method"] | "env"; details?: string };
}

const apiKeyFields: ReadonlyArray<ConfigureField> = [
  {
    name: "apiKey",
    label: "Daytona API key (https://app.daytona.io/dashboard/keys)",
    secret: true,
  },
  {
    name: "apiBaseUrl",
    label: "Daytona API URL",
    optional: true,
    placeholder: DEFAULT_API_BASE_URL,
  },
];

const storedConfig = (values: StoredValues): DaytonaAuthConfig => ({
  method: "stored",
  apiKey: Redacted.value(storedSecret(values.apiKey) ?? Redacted.make("")),
  apiBaseUrl: storedValueText(values.apiBaseUrl),
});

const toOAuthCredentials = (
  config: Extract<DaytonaAuthConfig, { method: "oauth" }>,
): OAuthClient.OAuthCredentials => ({
  type: "oauth",
  clientId: config.clientId,
  access: Redacted.make(config.access),
  refresh: Redacted.make(config.refresh),
  expires: config.expires,
  scopes: config.scopes,
});

const fromOAuthCredentials = (fresh: OAuthClient.OAuthCredentials) => ({
  clientId: fresh.clientId,
  access: Redacted.value(fresh.access),
  refresh: Redacted.value(fresh.refresh),
  expires: fresh.expires,
  scopes: fresh.scopes,
});

/** List the user's organizations and pick one (prompting when there are several). */
const selectOrganization = (accessToken: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const organizations = yield* listOrganizations({});
    const [only] = organizations;
    if (only === undefined) {
      return yield* AuthError.make({ message: "Daytona: this user belongs to no organization." });
    }
    if (organizations.length === 1) {
      yield* Interaction.info(`Daytona: using organization ${only.name} (${only.id})`);
      return only.id;
    }
    return yield* Interaction.select({
      message: "Select a Daytona organization",
      options: organizations.map((o) => ({ value: o.id, label: o.name, description: o.id })),
    }).pipe(mapPromptCancellation);
  }).pipe(
    Effect.provide(Layer.mergeAll(credentials({ apiKey: accessToken }), FetchHttpClient.layer)),
  );

/**
 * Layer that registers the Daytona {@link AuthProvider} into the
 * {@link AuthProviders} registry when built, so `alchemy profile edit` can
 * configure it.
 *
 * Supported methods:
 * - `oauth`: Daytona's device login (the same as `daytona login`); the
 *   session refreshes itself and can manage the organization.
 * - `stored`: an organization API key stored inline.
 */
export const DaytonaAuth = AuthProviderLayer<DaytonaAuthConfig, DaytonaResolvedCredentials>()(
  DAYTONA_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const configureOAuth = Effect.fn(function* (_profileName: string) {
      const authorization = yield* OAuthClient.deviceAuthorize();
      const session = yield* deviceOAuth({
        provider: "Daytona",
        authorization,
        token: OAuthClient.deviceToken(authorization),
      });
      const organizationId = yield* selectOrganization(session.access);
      yield* Interaction.success("Daytona: signed in.");
      return {
        method: "oauth" as const,
        organizationId,
        ...fromOAuthCredentials(session),
      };
    });

    const configureApiKey = (_profileName: string) =>
      collectFieldValues(apiKeyFields).pipe(
        Effect.map(storedConfig),
        Effect.tap(() => Interaction.success("Daytona: credentials saved.")),
      );

    const configure = (profileName: string) =>
      Interaction.select({
        message: "Daytona authentication method",
        options: [
          {
            value: "oauth" as const,
            label: "Sign in",
            description: "recommended — device login; can also manage the organization",
          },
          {
            value: "stored" as const,
            label: "API key",
            description: "an organization API key stored inline",
          },
        ],
      }).pipe(
        mapPromptCancellation,
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("oauth", () => configureOAuth(profileName)),
            Match.when("stored", () => configureApiKey(profileName)),
            Match.exhaustive,
          ),
        ),
        Effect.mapError((e) =>
          AuthError.make({ message: "failed to configure credentials", cause: e }),
        ),
      );

    // Sign-in needs a browser, so only the API key has a flag-driven form.
    const configureMethods: ReadonlyArray<ConfigureMethod> = [
      { method: "stored", fields: apiKeyFields },
    ];

    const configureWith = (
      _profileName: string,
      input: { readonly method: string; readonly values: Record<string, string> },
    ) =>
      input.method === "stored"
        ? validateFieldValues(DAYTONA_AUTH_PROVIDER_NAME, apiKeyFields, input.values).pipe(
            Effect.map(storedConfig),
            Effect.tap(() => Interaction.success("Daytona: credentials saved.")),
          )
        : Effect.fail(
            AuthError.make({
              message: `Daytona: unknown method '${input.method}'. Valid methods: stored. (Sign-in is interactive-only.)`,
            }),
          );

    const read = (
      profileName: string,
      config: DaytonaAuthConfig,
      updateConfig?: (config: DaytonaAuthConfig) => Effect.Effect<void, AuthError>,
    ) =>
      Match.value(config).pipe(
        Match.when({ method: "stored" }, (stored) =>
          Effect.succeed({
            type: "apiKey" as const,
            token: Redacted.make(stored.apiKey),
            apiBaseUrl: stored.apiBaseUrl ?? DEFAULT_API_BASE_URL,
            organizationId: stored.organizationId,
            source: { type: "stored" as const },
          } satisfies DaytonaResolvedCredentials),
        ),
        Match.when({ method: "oauth" }, (oauth) =>
          Effect.gen(function* () {
            const reauth = refreshHint(DAYTONA_AUTH_PROVIDER_NAME, profileName);
            const session = toOAuthCredentials(oauth);
            if (!OAuthClient.usesCurrentClient(session)) {
              return yield* NeedsReauth.make({
                provider: DAYTONA_AUTH_PROVIDER_NAME,
                profile: profileName,
                message: `Daytona credentials for profile '${profileName}' were issued to another OAuth client. ${reauth}`,
              });
            }
            // Refresh within a minute of expiry and persist it: WorkOS
            // refresh tokens are single-use.
            const now = yield* Clock.currentTimeMillis;
            const fresh =
              session.expires > now + 60_000
                ? session
                : yield* OAuthClient.refresh(session).pipe(
                    Effect.mapError((e) =>
                      NeedsReauth.make({
                        provider: DAYTONA_AUTH_PROVIDER_NAME,
                        profile: profileName,
                        message: `Daytona session refresh failed. ${reauth}`,
                        cause: e,
                      }),
                    ),
                  );
            if (fresh !== session) {
              yield* updateConfig?.({ ...oauth, ...fromOAuthCredentials(fresh) }) ?? Effect.void;
            }
            return {
              type: "oauth" as const,
              token: fresh.access,
              apiBaseUrl: oauth.apiBaseUrl ?? DEFAULT_API_BASE_URL,
              organizationId: oauth.organizationId,
              expires: fresh.expires,
              source: { type: "oauth" as const },
            } satisfies DaytonaResolvedCredentials;
          }),
        ),
        Match.exhaustive,
      );

    const login = (
      profileName: string,
      config: DaytonaAuthConfig,
      updateConfig?: (config: DaytonaAuthConfig) => Effect.Effect<void, AuthError>,
      reload?: Effect.Effect<DaytonaAuthConfig, AuthError>,
    ) =>
      Match.value(config).pipe(
        Match.when({ method: "stored" }, (stored) => Effect.succeed<DaytonaAuthConfig>(stored)),
        Match.when({ method: "oauth" }, (oauth) =>
          Effect.gen(function* () {
            if (!OAuthClient.usesCurrentClient(toOAuthCredentials(oauth))) {
              return yield* configureOAuth(profileName);
            }
            // Refresh with the token stored now, read under the lock.
            const outcome = yield* withProfileCredentialsLock(
              profileName,
              Effect.gen(function* () {
                const current = yield* reload ?? Effect.succeed(oauth);
                if (current.method !== "oauth") return { type: "signIn" as const };
                const session = toOAuthCredentials(current);
                if (!OAuthClient.usesCurrentClient(session)) return { type: "signIn" as const };
                const fresh = yield* OAuthClient.refresh(session);
                const config = { ...current, ...fromOAuthCredentials(fresh) };
                if (updateConfig === undefined) return { type: "refreshed" as const, config };
                yield* updateConfig(config);
                return { type: "refreshed" as const, config: undefined };
              }),
            ).pipe(
              Effect.catchTag(
                [
                  "OAuthError",
                  "OAuthNetworkError",
                  "OAuthServerUnavailable",
                  "OAuthInvalidResponse",
                ],
                () => Effect.succeed({ type: "signIn" as const }),
              ),
            );
            if (outcome.type === "signIn") return yield* configureOAuth(profileName);
            yield* Interaction.success("Daytona: session refreshed.");
            return outcome.config;
          }),
        ),
        Match.exhaustive,
        Effect.mapError((e) => AuthError.make({ message: "login failed", cause: e })),
      );

    const logout = (_profileName: string, _config: DaytonaAuthConfig) => Effect.void;

    const details = (
      profileName: string,
      config: DaytonaAuthConfig,
      updateConfig?: (config: DaytonaAuthConfig) => Effect.Effect<void, AuthError>,
    ) =>
      Effect.all([read(profileName, config, updateConfig), Clock.currentTimeMillis]).pipe(
        Effect.map(([creds, now]: [DaytonaResolvedCredentials, number]): ProviderDetails => {
          const lines = [
            {
              key: creds.type === "oauth" ? "accessToken" : "apiKey",
              value: displayRedacted(creds.token),
            },
            { key: "apiBaseUrl", value: creds.apiBaseUrl },
          ];
          if (creds.organizationId !== undefined) {
            lines.push({ key: "organizationId", value: creds.organizationId });
          }
          if (creds.expires !== undefined) {
            const remaining = creds.expires - now;
            const at = new Date(creds.expires).toISOString();
            lines.push({
              key: "expires",
              value:
                remaining <= 0
                  ? `expired (${at})`
                  : `in ${Duration.format(Duration.millis(remaining))} (${at})`,
            });
          }
          lines.push({ key: "source", value: creds.source.type });
          return { lines };
        }),
      );

    const readEnvironment = Effect.gen(function* () {
      const apiKey = yield* getEnvRedacted("DAYTONA_API_KEY");
      if (!apiKey) {
        return yield* AuthError.make({
          message: "Daytona CI credentials not found. Set DAYTONA_API_KEY.",
        });
      }
      return {
        type: "apiKey" as const,
        token: apiKey,
        apiBaseUrl: (yield* getEnv("DAYTONA_API_URL")) ?? DEFAULT_API_BASE_URL,
        organizationId: yield* getEnv("DAYTONA_ORGANIZATION_ID"),
        source: { type: "env" as const },
      } satisfies DaytonaResolvedCredentials;
    });

    return {
      configSchema: DaytonaAuthConfigSchema,
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
          name: "DAYTONA_API_KEY",
          required: true,
          secret: true,
          description: "Organization API key.",
        },
        {
          name: "DAYTONA_API_URL",
          required: false,
          description: "API root for a self-hosted Daytona.",
        },
        {
          name: "DAYTONA_ORGANIZATION_ID",
          required: false,
          description: "Organization id; only needed with a user token.",
        },
      ],
    };
  }),
);
