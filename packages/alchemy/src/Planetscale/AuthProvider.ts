import { listOrganizations } from "@distilled.cloud/planetscale";
import * as PsCredentialsModule from "@distilled.cloud/planetscale/Credentials";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  AuthError,
  AuthProviderLayer,
  needsReauth,
  type ConfigureField,
  type ConfigureMethod,
  type NeedsReauth,
  type ProviderDetails,
} from "../Auth/AuthProvider.ts";
import { validateFieldValues } from "../Auth/StoredAuthProvider.ts";
import { CredentialsStore, displayRedacted } from "../Auth/Credentials.ts";
import { withProfileCredentialsLock } from "../Auth/Lock.ts";
import {
  getEnvRedactedRequired,
  getEnvRequired,
  mapPromptCancellation,
} from "../Auth/Env.ts";
import { browserOAuth } from "../Auth/BrowserOAuth.ts";
import * as CliKit from "../Cli/CliKit/index.ts";
import * as OAuthClient from "./OAuthClient.ts";

/**
 * Canonical name registered in {@link AuthProviders}. Use this key to look
 * up the PlanetScale {@link AuthProvider} from inside provider Layers.
 */
export const PLANETSCALE_AUTH_PROVIDER_NAME = "Planetscale";

/**
 * Provide PlanetScale `Credentials` + `HttpClient` to an Effect using a
 * just-obtained OAuth access token. Used during configure to call
 * org-discovery endpoints before the user has chosen an org.
 *
 * `organization` is required by the credential type but isn't consulted by
 * `listOrganizations` (it's a user-scoped endpoint), so an empty string is
 * fine here.
 */
const withOAuthCredentials = <A, E>(
  accessToken: string,
  effect: Effect.Effect<
    A,
    E,
    PsCredentialsModule.Credentials | HttpClient.HttpClient
  >,
): Effect.Effect<A, E> =>
  Effect.provide(
    effect,
    Layer.mergeAll(
      PsCredentialsModule.fromOAuth({
        accessToken,
        organization: "",
      }),
      FetchHttpClient.layer,
    ),
  );

/**
 * List the organizations the OAuth user belongs to and either auto-pick
 * (one org) or prompt the user to choose. Returns the org's URL slug
 * (`name` field, used as `{organization}` in API paths).
 */
const selectOrganization = (accessToken: string) =>
  Effect.gen(function* () {
    const prompt = yield* CliKit.CliKit;
    const list = yield* listOrganizations;
    const response = yield* list({});
    const orgs = response.data;
    if (orgs.length === 0) {
      return yield* new AuthError({
        message: "Planetscale: no organizations found for this credential.",
      });
    }
    if (orgs.length === 1) {
      const org = orgs[0]!;
      yield* prompt.output.info(
        `Planetscale: using organization: ${org.name} (${org.id})`,
      );
      return org.name;
    }
    return yield* prompt.prompt
      .select({
        message: "Select a Planetscale organization",
        options: orgs.map((o) => ({
          value: o.name,
          label: o.name,
          description: o.id,
        })),
      })
      .pipe(mapPromptCancellation);
  }).pipe((e) => withOAuthCredentials(accessToken, e));

const options: Array<{
  value: PlanetscaleAuthConfig["method"];
  label: string;
  description?: string;
}> = [
  {
    value: "oauth",
    label: "OAuth",
    description:
      "recommended — browser-based login with automatic token refresh",
  },
  {
    value: "stored",
    label: "Service Token",
    description:
      "enter service token interactively, stored in ~/.alchemy/credentials",
  },
];

/**
 * Auth configuration persisted in `~/.alchemy/profiles.json` for the
 * PlanetScale provider.
 *
 * - `stored`: read service-token credentials from
 *   `~/.alchemy/credentials/<profile>/planetscale-stored.json`.
 * - `oauth`: browser-based login; the access/refresh tokens are stored at
 *   `~/.alchemy/credentials/<profile>/planetscale-oauth.json` and refreshed
 *   on demand. PlanetScale has no PKCE flow, so the OAuth application's
 *   `client_secret` ships in the CLI — see {@link OAuthClient}.
 */
export type PlanetscaleAuthConfig =
  | { method: "stored" }
  | { method: "oauth"; organization: string };

/** Manifest-entry schema for {@link PlanetscaleAuthConfig}. */
export const PlanetscaleAuthConfigSchema: Schema.Codec<
  PlanetscaleAuthConfig,
  any
> = Schema.Union([
  Schema.Struct({ method: Schema.Literal("stored") }),
  Schema.Struct({
    method: Schema.Literal("oauth"),
    organization: Schema.String,
  }),
]);

/**
 * apiToken credentials persisted to disk for `method: "stored"`.
 * Stored under the file key `"planetscale-stored"`.
 */
export const PlanetscaleStoredCredentials = Schema.Struct({
  type: Schema.Literal("apiToken"),
  tokenId: Schema.String,
  token: Schema.String,
  organization: Schema.String,
});
export type PlanetscaleStoredCredentials =
  typeof PlanetscaleStoredCredentials.Type;

/** Credential-store file keys (`~/.alchemy/credentials/{profile}/{key}.json`). */
const STORED_STORAGE_KEY = "planetscale-stored";
const OAUTH_STORAGE_KEY = "planetscale-oauth";

/**
 * Resolved in-memory PlanetScale credentials returned by
 * {@link AuthProviderImpl.read}. Either a service token (`tokenId`/`token`)
 * or an OAuth access token.
 */
export type PlanetscaleResolvedCredentials =
  | {
      type: "apiToken";
      tokenId: Redacted.Redacted<string>;
      token: Redacted.Redacted<string>;
      organization: string;
      source: {
        type: PlanetscaleAuthConfig["method"] | "env";
        details?: string;
      };
    }
  | {
      type: "oauth";
      accessToken: Redacted.Redacted<string>;
      expires: number;
      organization: string;
      source: {
        type: PlanetscaleAuthConfig["method"] | "env";
        details?: string;
      };
    };

/**
 * Layer that registers the PlanetScale {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Include this in the
 * PlanetScale `providers()` layer so the alchemy CLI can discover it.
 *
 * Supported methods:
 * - `stored`: prompts for a service token interactively and writes it to
 *   `~/.alchemy/credentials/<profile>/planetscale-stored.json`.
 * - `oauth`: browser-based login storing access/refresh tokens at
 *   `~/.alchemy/credentials/<profile>/planetscale-oauth.json`.
 */
export const PlanetscaleAuth = AuthProviderLayer<
  PlanetscaleAuthConfig,
  PlanetscaleResolvedCredentials
>()(
  PLANETSCALE_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const prompt = yield* CliKit.CliKit;
    const store = yield* CredentialsStore;

    const oauthLogin = (profileName: string) =>
      Effect.gen(function* () {
        const authorization = OAuthClient.authorize();

        const credentials = yield* browserOAuth({
          provider: "Planetscale",
          url: authorization.url,
          callback: OAuthClient.callback(authorization),
          exchange: (input) =>
            OAuthClient.exchangeCallbackInput(input, authorization),
        });
        yield* store.write(
          profileName,
          OAUTH_STORAGE_KEY,
          OAuthClient.OAuthCredentials,
          credentials,
        );
        yield* prompt.output.success("Planetscale: OAuth credentials saved.");
        return credentials;
      });

    const configureOAuth = Effect.fn(function* (profileName: string) {
      const oauthCreds = yield* oauthLogin(profileName);

      // Use the just-issued access token to list the user's orgs and let
      // them pick (mirrors Cloudflare's selectAccount). Requires the
      // `user:read_organizations` scope. If the call fails for any
      // reason — missing scope, network, off-spec response — fall back
      // to a manual prompt so login still completes.
      const organization = yield* selectOrganization(oauthCreds.access).pipe(
        Effect.catch((e) =>
          Effect.gen(function* () {
            yield* prompt.output.warning(
              `Planetscale: could not auto-list organizations (${String(e)}). Falling back to manual entry.`,
            );
            return yield* prompt.prompt
              .text({
                message: "Planetscale Organization (URL slug)",
                validate: (v) => (v.length === 0 ? "Required" : undefined),
              })
              .pipe(mapPromptCancellation);
          }),
        ),
      );

      return { method: "oauth" as const, organization };
    });

    const loginStored = Effect.fn(function* (profileName: string) {
      const tokenId = yield* prompt.prompt
        .text({
          message: "Planetscale Service Token ID",
          validate: (v) => (v.length === 0 ? "Required" : undefined),
        })
        .pipe(mapPromptCancellation);

      const token = yield* prompt.prompt
        .password({
          message: "Planetscale Service Token",
          validate: (v) => (v.length === 0 ? "Required" : undefined),
        })
        .pipe(mapPromptCancellation);

      const organization = yield* prompt.prompt
        .text({
          message: "Planetscale Organization (URL slug)",
          validate: (v) => (v.length === 0 ? "Required" : undefined),
        })
        .pipe(mapPromptCancellation);

      yield* store.write(
        profileName,
        STORED_STORAGE_KEY,
        PlanetscaleStoredCredentials,
        {
          type: "apiToken",
          tokenId,
          token,
          organization,
        },
      );
      yield* prompt.output.success("Planetscale: credentials saved.");
      return { method: "stored" as const };
    });

    const configureInteractive = (profileName: string) =>
      prompt.prompt
        .select({
          message: "Planetscale authentication method",
          options,
        })
        .pipe(
          Effect.flatMap((method) =>
            Match.value(method).pipe(
              Match.when("oauth", () => configureOAuth(profileName)),
              Match.when("stored", () => loginStored(profileName)),
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
     * Flag-driven (`--method service-token --set ...`) fields, mirroring the
     * interactive service-token prompts. OAuth requires a browser and stays
     * interactive-only, so it is deliberately absent from
     * {@link configureMethods}.
     */
    const serviceTokenFields: ReadonlyArray<ConfigureField> = [
      { name: "tokenId", label: "Planetscale Service Token ID" },
      { name: "token", label: "Planetscale Service Token", secret: true },
      { name: "organization", label: "Planetscale Organization (URL slug)" },
    ];

    const configureMethods: ReadonlyArray<ConfigureMethod> = [
      { method: "service-token", fields: serviceTokenFields },
    ];

    const configureWith = (
      profileName: string,
      input: {
        readonly method: string;
        readonly values: Record<string, string>;
      },
    ): Effect.Effect<PlanetscaleAuthConfig, AuthError> =>
      input.method === "service-token"
        ? validateFieldValues(
            PLANETSCALE_AUTH_PROVIDER_NAME,
            serviceTokenFields,
            input.values,
          ).pipe(
            Effect.flatMap((values) =>
              store.write(
                profileName,
                STORED_STORAGE_KEY,
                PlanetscaleStoredCredentials,
                {
                  type: "apiToken",
                  tokenId: values.tokenId!,
                  token: values.token!,
                  organization: values.organization!,
                },
              ),
            ),
            Effect.andThen(
              prompt.output.success("Planetscale: credentials saved."),
            ),
            Effect.as({ method: "stored" as const }),
          )
        : Effect.fail(
            new AuthError({
              message: `Planetscale: unknown method '${input.method}'. Only 'service-token' is supported (OAuth is interactive-only).`,
            }),
          );

    const resolveCredentials = (
      profileName: string,
      config: PlanetscaleAuthConfig,
    ): Effect.Effect<PlanetscaleResolvedCredentials, AuthError | NeedsReauth> =>
      Match.value(config).pipe(
        Match.when({ method: "stored" }, () =>
          store
            .read(profileName, STORED_STORAGE_KEY, PlanetscaleStoredCredentials)
            .pipe(
              Effect.flatMap((creds) =>
                creds == null
                  ? Effect.fail(
                      needsReauth({
                        provider: PLANETSCALE_AUTH_PROVIDER_NAME,
                        profile: profileName,
                        detail: "Planetscale stored credentials not found.",
                      }),
                    )
                  : Effect.succeed({
                      type: "apiToken" as const,
                      tokenId: Redacted.make(creds.tokenId),
                      token: Redacted.make(creds.token),
                      organization: creds.organization,
                      source: {
                        type: "stored" as const,
                        details: undefined,
                      },
                    } satisfies PlanetscaleResolvedCredentials),
              ),
            ),
        ),
        Match.when({ method: "oauth" }, (cfg) =>
          Effect.gen(function* () {
            const creds = yield* store.read(
              profileName,
              OAUTH_STORAGE_KEY,
              OAuthClient.OAuthCredentials,
            );
            if (creds == null || creds.type !== "oauth") {
              return yield* Effect.fail(
                needsReauth({
                  provider: PLANETSCALE_AUTH_PROVIDER_NAME,
                  profile: profileName,
                  detail: "Planetscale OAuth credentials not found.",
                }),
              );
            }
            if (!OAuthClient.usesCurrentClient(creds)) {
              yield* store.delete(profileName, OAUTH_STORAGE_KEY);
              return yield* Effect.fail(
                needsReauth({
                  provider: PLANETSCALE_AUTH_PROVIDER_NAME,
                  profile: profileName,
                  detail: `Planetscale OAuth credentials for profile '${profileName}' were issued to an incompatible OAuth client and have been removed.`,
                }),
              );
            }
            // Refresh proactively if the token has expired (or is within
            // 10s of expiring). Persist the refreshed creds so subsequent
            // resolves don't repeat the round-trip.
            const fresh =
              creds.expires > Date.now() + 10_000
                ? creds
                : yield* OAuthClient.refresh(creds).pipe(
                    // Only the refresh round-trip maps to NeedsReauth — a
                    // failed persist afterwards is a local I/O AuthError and
                    // passes through untouched.
                    Effect.mapError((e) =>
                      needsReauth({
                        provider: PLANETSCALE_AUTH_PROVIDER_NAME,
                        profile: profileName,
                        detail: "Planetscale OAuth refresh failed.",
                        cause: e,
                      }),
                    ),
                    Effect.tap((refreshed) =>
                      store.write(
                        profileName,
                        OAUTH_STORAGE_KEY,
                        OAuthClient.OAuthCredentials,
                        refreshed,
                      ),
                    ),
                  );
            return {
              type: "oauth" as const,
              accessToken: Redacted.make(fresh.access),
              expires: fresh.expires,
              organization: cfg.organization,
              source: { type: "oauth" as const },
            } satisfies PlanetscaleResolvedCredentials;
          }),
        ),
        Match.exhaustive,
      );

    const logout = (profileName: string, config: PlanetscaleAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, STORED_STORAGE_KEY)
            .pipe(
              Effect.andThen(
                prompt.output.success(
                  "Planetscale: stored credentials removed",
                ),
              ),
            ),
        ),
        // PlanetScale publishes no token-revocation endpoint, so logout just
        // drops the locally stored tokens.
        Match.when({ method: "oauth" }, () =>
          store
            .delete(profileName, OAUTH_STORAGE_KEY)
            .pipe(
              Effect.andThen(
                prompt.output.success(
                  "Planetscale: OAuth credentials removed.",
                ),
              ),
            ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: PlanetscaleAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "stored" }, () =>
            store
              .read(
                profileName,
                STORED_STORAGE_KEY,
                PlanetscaleStoredCredentials,
              )
              .pipe(
                Effect.flatMap((creds) =>
                  creds == null ? loginStored(profileName) : Effect.void,
                ),
              ),
          ),
          Match.when({ method: "oauth" }, () =>
            Effect.gen(function* () {
              const creds = yield* store.read(
                profileName,
                OAUTH_STORAGE_KEY,
                OAuthClient.OAuthCredentials,
              );

              // The silent refresh rotates a single-use refresh token, so
              // its read-refresh-persist section runs under the profile
              // lock — a concurrent `read` refreshing the same token would
              // double-spend it. The lock is held only for this API
              // round-trip, never across the browser wait below.
              const outcome =
                creds?.type === "oauth" && OAuthClient.usesCurrentClient(creds)
                  ? yield* withProfileCredentialsLock(
                      profileName,
                      prompt.output
                        .info("Planetscale: refreshing OAuth credentials...")
                        .pipe(
                          Effect.andThen(OAuthClient.refresh(creds)),
                          Effect.flatMap((refreshed) =>
                            store
                              .write(
                                profileName,
                                OAUTH_STORAGE_KEY,
                                OAuthClient.OAuthCredentials,
                                refreshed,
                              )
                              .pipe(
                                Effect.andThen(
                                  prompt.output.success(
                                    "Planetscale: OAuth credentials refreshed.",
                                  ),
                                ),
                              ),
                          ),
                          Effect.as("refreshed" as const),
                          Effect.catchTag("OAuthError", () =>
                            Effect.succeed("browser" as const),
                          ),
                        ),
                    )
                  : yield* Effect.gen(function* () {
                      if (creds?.type === "oauth") {
                        yield* store.delete(profileName, OAUTH_STORAGE_KEY);
                        yield* prompt.output.warning(
                          "Planetscale: removed OAuth credentials issued to the previous client.",
                        );
                      }
                      return "browser" as const;
                    });
              if (outcome === "browser") {
                yield* oauthLogin(profileName);
              }
            }),
          ),
          Match.exhaustive,
        )
        .pipe(
          Effect.mapError(
            (e) => new AuthError({ message: "login failed", cause: e }),
          ),
        );

    const details = (
      profileName: string,
      config: PlanetscaleAuthConfig,
    ): Effect.Effect<ProviderDetails, AuthError | NeedsReauth> =>
      resolveCredentials(profileName, config).pipe(
        Effect.map((creds): ProviderDetails => {
          const sourceStr = creds.source.details
            ? `${creds.source.type} - ${creds.source.details}`
            : creds.source.type;
          return Match.value(creds).pipe(
            Match.when({ type: "apiToken" }, (c) => ({
              lines: [
                { key: "tokenId", value: displayRedacted(c.tokenId, 3) },
                { key: "token", value: displayRedacted(c.token, 6) },
                { key: "organization", value: c.organization },
                { key: "source", value: sourceStr },
              ],
            })),
            Match.when({ type: "oauth" }, (c) => {
              const remainingMs = c.expires - Date.now();
              const expiresAt = new Date(c.expires).toISOString();
              const expiresStr =
                remainingMs <= 0
                  ? `expired (${expiresAt})`
                  : `in ${Duration.format(Duration.millis(remainingMs))} (${expiresAt})`;
              return {
                lines: [
                  { key: "accessToken", value: displayRedacted(c.accessToken) },
                  { key: "expires", value: expiresStr },
                  { key: "organization", value: c.organization },
                  { key: "source", value: sourceStr },
                ],
              };
            }),
            Match.exhaustive,
          );
        }),
      );

    const readEnvironment = Effect.gen(function* () {
      const tokenId = yield* getEnvRedactedRequired("PLANETSCALE_API_TOKEN_ID");
      const token = yield* getEnvRedactedRequired("PLANETSCALE_API_TOKEN");
      const organization = yield* getEnvRequired("PLANETSCALE_ORGANIZATION");
      return {
        type: "apiToken" as const,
        tokenId,
        token,
        organization,
        source: {
          type: "env" as const,
          details: "PLANETSCALE_API_TOKEN_ID/PLANETSCALE_API_TOKEN",
        },
      } satisfies PlanetscaleResolvedCredentials;
    });

    return {
      configSchema: PlanetscaleAuthConfigSchema,
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
          name: "PLANETSCALE_API_TOKEN_ID",
          required: true,
          description: "Service token id.",
        },
        {
          name: "PLANETSCALE_API_TOKEN",
          required: true,
          secret: true,
          description: "Service token secret.",
        },
        {
          name: "PLANETSCALE_ORGANIZATION",
          required: true,
          description: "Organization URL slug.",
        },
        {
          name: "PLANETSCALE_API_BASE_URL",
          required: false,
          description: "API base URL override.",
        },
      ],
    };
  }),
);
