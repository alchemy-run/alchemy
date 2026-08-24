import * as cfAccounts from "@distilled.cloud/cloudflare/accounts";
import * as cfMemberships from "@distilled.cloud/cloudflare/memberships";
import * as CfCredentialsModule from "@distilled.cloud/cloudflare/Credentials";
import * as Clock from "effect/Clock";
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
  NeedsReauth,
  refreshHint,
  type ConfigureField,
  type ConfigureMethod,
  type ProviderDetails,
} from "../../Auth/AuthProvider.ts";
import {
  storedSecret,
  storedValueText,
  validateFieldValues,
} from "../../Auth/StoredAuthProvider.ts";
import { CredentialsStore, displayRedacted } from "../../Auth/Credentials.ts";
import { withProfileCredentialsLock } from "../../Auth/Lock.ts";
import {
  getEnvRedacted,
  getEnvRequired,
  mapPromptCancellation,
} from "../../Auth/Env.ts";
import { browserOAuth } from "../../Auth/BrowserOAuth.ts";
import * as CliKit from "../../Cli/CliKit/index.ts";
import { profileCommandHint } from "../../Util/interactive.ts";
import { CREDENTIALS_FILE as STATE_STORE_CREDENTIALS_FILE } from "../StateStore/CredentialsFile.ts";
import * as OAuthClient from "./OAuthClient.ts";
import {
  CLOUDFLARE_AUTH_PROVIDER_NAME,
  CloudflareAuthConfigSchema,
  CloudflareStoredCredentials,
  OAUTH_STORAGE_KEY,
  STORED_STORAGE_KEY,
  validateAccountId,
  validateAccountIdField,
  type CloudflareAuthConfig,
  type CloudflareResolvedCredentials,
} from "./AuthConfig.ts";
import {
  ALL_SCOPE_IDS,
  BASIC_SCOPES,
  customOAuthScopeDefaults,
  OAUTH_SCOPE_GROUPS,
  OAUTH_SCOPE_NAMES,
  partitionOAuthScopes,
} from "./OAuthScopes.ts";

const options: Array<{
  value: CloudflareAuthConfig["method"];
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
    label: "API Token or API Key",
    description: "use an API token or global API key",
  },
];

const withOAuthCredentials = <A, E, R>(
  accessToken: string,
  effect: Effect.Effect<
    A,
    E,
    R | CfCredentialsModule.Credentials | HttpClient.HttpClient
  >,
): Effect.Effect<A, E, R> =>
  Effect.provide(
    effect,
    Layer.mergeAll(
      CfCredentialsModule.fromOAuth({
        load: Effect.succeed({ accessToken }),
        refresh: () =>
          Effect.die("refresh not expected during account selection"),
      }),
      FetchHttpClient.layer,
    ),
  );

/**
 * Accounts visible to a user-scoped OAuth token. `GET /accounts` returns an
 * EMPTY list for these tokens (it only lists accounts an account-scoped
 * credential can read), so memberships are the authoritative account list —
 * the same endpoint wrangler uses. `GET /accounts` remains as a fallback for
 * tokens authorized without `memberships.read` (custom scope selections).
 */
const listVisibleAccounts: Effect.Effect<
  ReadonlyArray<{ id: string; name: string }>,
  unknown,
  CfCredentialsModule.Credentials | HttpClient.HttpClient
> = Effect.gen(function* () {
  const listMemberships = yield* cfMemberships.listMemberships;
  const membershipAccounts = yield* listMemberships({}).pipe(
    Effect.map((response) =>
      response.result.flatMap((membership) =>
        membership.account != null &&
        (membership.status == null || membership.status === "accepted")
          ? [membership.account]
          : [],
      ),
    ),
    Effect.catch((error) =>
      Effect.logDebug("Cloudflare: listing memberships failed", error).pipe(
        Effect.as([] as Array<{ id: string; name: string }>),
      ),
    ),
  );
  if (membershipAccounts.length > 0) return membershipAccounts;
  const listAccounts = yield* cfAccounts.listAccounts;
  const response = yield* listAccounts({});
  yield* Effect.logDebug(
    `Cloudflare: memberships listed 0 accounts; /accounts listed ${response.result.length}`,
  );
  return response.result;
});

const selectAccount = (accessToken: string) =>
  Effect.gen(function* () {
    const prompt = CliKit.accessors;
    const accounts = yield* listVisibleAccounts;
    if (accounts.length === 0) {
      return yield* new AuthError({
        message:
          "No Cloudflare accounts are visible to this credential. " +
          "Ensure the authorized OAuth scopes include 'memberships.read'.",
      });
    }
    const [account] = accounts;
    if (accounts.length === 1 && account !== undefined) {
      yield* prompt.output.info(`Using Cloudflare account ${account.name}.`);
      return account.id;
    }
    return yield* prompt.prompt
      .select({
        message: "Select a Cloudflare account",
        searchable: true,
        options: accounts.map((a) => ({
          value: a.id,
          label: a.name,
          description: a.id,
        })),
      })
      .pipe(mapPromptCancellation);
  }).pipe((e) => withOAuthCredentials(accessToken, e));

const promptAccountId = () =>
  Effect.gen(function* () {
    const prompt = yield* CliKit.CliKit;
    return yield* prompt.prompt
      .text({
        message: "Cloudflare Account ID",
        validate: validateAccountIdField,
      })
      .pipe(mapPromptCancellation);
  });

const accountIdField: ConfigureField = {
  name: "accountId",
  label: "Cloudflare Account ID",
  validate: validateAccountIdField,
};

/** `--set` fields for `--method api-token`. */
const apiTokenFields: ReadonlyArray<ConfigureField> = [
  { name: "apiToken", label: "Cloudflare API Token", secret: true },
  accountIdField,
];

/** `--set` fields for `--method api-key`. */
const apiKeyFields: ReadonlyArray<ConfigureField> = [
  { name: "apiKey", label: "Cloudflare API Key", secret: true },
  { name: "email", label: "Cloudflare Email" },
  accountIdField,
];

/**
 * Flag-driven configuration methods. OAuth is deliberately absent — it is
 * interactive-only (browser grant).
 */
const configureMethods: ReadonlyArray<ConfigureMethod> = [
  { method: "api-token", fields: apiTokenFields },
  { method: "api-key", fields: apiKeyFields },
];

const promptOAuthScopes = (currentConfig?: CloudflareAuthConfig) =>
  Effect.gen(function* () {
    const prompt = yield* CliKit.CliKit;
    const mode = yield* prompt.prompt
      .select({
        message: "Cloudflare OAuth scopes",
        options: [
          {
            value: "basic" as const,
            label: "Basic Scopes",
            description: "recommended — covers typical Alchemy use cases",
          },
          {
            value: "all" as const,
            label: "All Scopes",
            description: "authorize every available Cloudflare permission",
          },
          {
            value: "custom" as const,
            label: "Custom Scopes",
            description: "choose individual permissions",
          },
        ],
      })
      .pipe(mapPromptCancellation);
    if (mode === "basic") return [...BASIC_SCOPES];
    if (mode === "all") return [...ALL_SCOPE_IDS];
    return yield* prompt.prompt
      .multiSelect({
        message: "Select OAuth scopes",
        initialValues: customOAuthScopeDefaults(currentConfig),
        searchable: true,
        descriptionPlacement: "inline",
        options: OAUTH_SCOPE_GROUPS.flatMap((group) =>
          group.scopes.map((value) => ({
            value,
            label: OAUTH_SCOPE_NAMES[value],
            description: value,
            group: group.label,
          })),
        ),
        required: true,
      })
      .pipe(mapPromptCancellation);
  });

/**
 * Layer that registers the Cloudflare {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Include this in the Cloudflare
 * `providers()` layer so the alchemy CLI can discover it.
 */
export const CloudflareAuth = AuthProviderLayer<
  CloudflareAuthConfig,
  CloudflareResolvedCredentials
>()(
  CLOUDFLARE_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const prompt = CliKit.accessors;
    const store = yield* CredentialsStore;

    const oauthLogin = (profileName: string, scopes: string[]) =>
      Effect.gen(function* () {
        const authorization = yield* OAuthClient.authorize([
          ...scopes,
          "offline_access",
        ]);

        const credentials = yield* browserOAuth({
          provider: "Cloudflare",
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
        yield* prompt.output.success("Connected to Cloudflare with OAuth.");
        return credentials;
      });

    const loginStored = Effect.fn(function* (profileName: string) {
      const credentialType = yield* prompt.prompt
        .select({
          message: "Cloudflare credential type",
          options: [
            {
              value: "apiToken" as const,
              label: "API Token",
              description: "recommended",
            },
            { value: "apiKey" as const, label: "API Key + Email" },
          ],
        })
        .pipe(mapPromptCancellation);

      return yield* Match.value(credentialType).pipe(
        Match.when("apiToken", () =>
          Effect.gen(function* () {
            const apiToken = yield* prompt.prompt
              .password({
                message: "Cloudflare API Token",
                validate: (v) => (v.length === 0 ? "Required" : undefined),
              })
              .pipe(mapPromptCancellation, Effect.map(Redacted.make));
            const accountId = yield* promptAccountId();

            yield* store.write(
              profileName,
              STORED_STORAGE_KEY,
              CloudflareStoredCredentials,
              { type: "apiToken", apiToken, accountId },
            );
            yield* prompt.output.success("Cloudflare: credentials saved.");
            return {
              method: "stored" as const,
              credentialType: "apiToken" as const,
            };
          }),
        ),
        Match.when("apiKey", () =>
          Effect.gen(function* () {
            const apiKey = yield* prompt.prompt
              .password({
                message: "Cloudflare API Key",
                validate: (v) => (v.length === 0 ? "Required" : undefined),
              })
              .pipe(mapPromptCancellation, Effect.map(Redacted.make));

            const email = yield* prompt.prompt
              .text({
                message: "Cloudflare Email",
                validate: (v) => (v.length === 0 ? "Required" : undefined),
              })
              .pipe(mapPromptCancellation, Effect.map(Redacted.make));
            const accountId = yield* promptAccountId();

            yield* store.write(
              profileName,
              STORED_STORAGE_KEY,
              CloudflareStoredCredentials,
              { type: "apiKey", apiKey, email, accountId },
            );
            yield* prompt.output.success("Cloudflare: credentials saved.");
            return {
              method: "stored" as const,
              credentialType: "apiKey" as const,
            };
          }),
        ),
        Match.exhaustive,
      );
    });

    const configureOAuth = Effect.fn(function* (
      profileName: string,
      currentConfig?: CloudflareAuthConfig,
    ) {
      const scopes = yield* promptOAuthScopes(currentConfig);

      const oauthCreds = yield* oauthLogin(profileName, [...scopes]);

      const accountId = yield* selectAccount(
        Redacted.value(oauthCreds.access),
      ).pipe(
        // Keep AuthError messages intact — they carry the actionable
        // diagnosis (e.g. "no accounts visible"); only wrap raw API errors.
        Effect.mapError((e) =>
          e instanceof AuthError
            ? e
            : new AuthError({
                message: "Cloudflare: could not list accounts",
                cause: e,
              }),
        ),
      );

      return {
        method: "oauth" as const,
        scopes: [...scopes],
        accountId,
      };
    });

    const configureInteractive = (
      profileName: string,
      currentConfig?: CloudflareAuthConfig,
    ) =>
      prompt.prompt
        .select({
          message: "Cloudflare authentication method",
          options,
        })
        .pipe(
          Effect.flatMap((method) =>
            Match.value(method).pipe(
              Match.when("oauth", () =>
                configureOAuth(profileName, currentConfig),
              ),
              Match.when("stored", () => loginStored(profileName)),
              Match.exhaustive,
            ),
          ),
        );

    const configureCredentials = (
      profileName: string,
      currentConfig?: CloudflareAuthConfig,
    ) =>
      Effect.gen(function* () {
        const config = yield* configureInteractive(profileName, currentConfig);
        // Re-configuring auth may point this profile at a different
        // Cloudflare account. The cached state-store credentials
        // (`~/.alchemy/credentials/{profile}/cloudflare-state-store.json`)
        // are minted per-account, so drop them here; the next deploy
        // re-derives them against the freshly-configured account.
        yield* store
          .delete(profileName, STATE_STORE_CREDENTIALS_FILE)
          .pipe(Effect.ignore);
        return config;
      }).pipe(
        // AuthError messages are already user-facing; re-wrapping them in a
        // generic banner is what hid "no accounts visible" behind
        // "failed to configure credentials".
        Effect.mapError((e) =>
          e instanceof AuthError
            ? e
            : new AuthError({
                message: "failed to configure credentials",
                cause: e,
              }),
        ),
      );

    const resolveCredentials = (
      profileName: string,
      config: CloudflareAuthConfig,
    ) =>
      Effect.gen(function* () {
        const reauth = yield* refreshHint(
          CLOUDFLARE_AUTH_PROVIDER_NAME,
          profileName,
        );
        return yield* Match.value(config).pipe(
          Match.when({ method: "stored" }, () =>
            store
              .read(
                profileName,
                STORED_STORAGE_KEY,
                CloudflareStoredCredentials,
              )
              .pipe(
                Effect.flatMap(
                  Effect.fn(function* (creds) {
                    if (creds == null) {
                      return yield* Effect.fail(
                        new NeedsReauth({
                          provider: CLOUDFLARE_AUTH_PROVIDER_NAME,
                          profile: profileName,
                          message: `Cloudflare stored credentials not found. ${reauth}`,
                        }),
                      );
                    }
                    const accountId = yield* validateAccountId(
                      creds.accountId,
                      `stored for profile '${profileName}'`,
                    );
                    return Match.value(creds).pipe(
                      Match.when({ type: "apiToken" }, (c) => ({
                        type: "apiToken" as const,
                        apiToken: c.apiToken,
                        accountId,
                        source: { type: "stored" as const },
                      })),
                      Match.when({ type: "apiKey" }, (c) => ({
                        type: "apiKey" as const,
                        apiKey: c.apiKey,
                        email: c.email,
                        accountId,
                        source: { type: "stored" as const },
                      })),
                      Match.exhaustive,
                    );
                  }),
                ),
              ),
          ),
          Match.when({ method: "oauth" }, (cfg) =>
            Effect.gen(function* () {
              const accountId = yield* validateAccountId(
                cfg.accountId,
                `configured for profile '${profileName}'`,
              );
              const creds = yield* store.read(
                profileName,
                OAUTH_STORAGE_KEY,
                OAuthClient.OAuthCredentials,
              );
              if (creds == null || creds.type !== "oauth") {
                return yield* Effect.fail(
                  new NeedsReauth({
                    provider: CLOUDFLARE_AUTH_PROVIDER_NAME,
                    profile: profileName,
                    message: `Cloudflare OAuth credentials not found. ${reauth}`,
                  }),
                );
              }
              if (!OAuthClient.usesCurrentClient(creds)) {
                yield* store.delete(profileName, OAUTH_STORAGE_KEY);
                return yield* Effect.fail(
                  new NeedsReauth({
                    provider: CLOUDFLARE_AUTH_PROVIDER_NAME,
                    profile: profileName,
                    message: `Cloudflare OAuth credentials for profile '${profileName}' were issued to an incompatible OAuth client and have been removed. ${reauth}`,
                  }),
                );
              }
              // Refresh proactively if the token has expired (or is within
              // 10s of expiring). Persist the refreshed creds so subsequent
              // resolves don't repeat the round-trip.
              const now = yield* Clock.currentTimeMillis;
              const fresh =
                creds.expires > now + 10_000
                  ? creds
                  : yield* OAuthClient.refresh(creds).pipe(
                      Effect.tap((refreshed) =>
                        store.write(
                          profileName,
                          OAUTH_STORAGE_KEY,
                          OAuthClient.OAuthCredentials,
                          refreshed,
                        ),
                      ),
                      Effect.mapError(
                        (e) =>
                          new NeedsReauth({
                            provider: CLOUDFLARE_AUTH_PROVIDER_NAME,
                            profile: profileName,
                            message: `Cloudflare OAuth refresh failed. ${reauth}`,
                            cause: e,
                          }),
                      ),
                    );
              return {
                type: "oauth" as const,
                accessToken: fresh.access,
                expires: fresh.expires,
                accountId,
                source: { type: "oauth" as const },
              };
            }),
          ),
          Match.exhaustive,
        );
      });

    const readEnvironment = Effect.gen(function* () {
      const accountId = yield* getEnvRequired("CLOUDFLARE_ACCOUNT_ID").pipe(
        Effect.flatMap((id) =>
          validateAccountId(id, "from CLOUDFLARE_ACCOUNT_ID"),
        ),
      );
      const apiToken = yield* getEnvRedacted("CLOUDFLARE_API_TOKEN");
      if (apiToken) {
        return {
          type: "apiToken" as const,
          apiToken,
          accountId,
          source: { type: "env" as const },
        };
      }
      const apiKey = yield* getEnvRedacted("CLOUDFLARE_API_KEY");
      const email =
        (yield* getEnvRedacted("CLOUDFLARE_EMAIL")) ??
        (yield* getEnvRedacted("CLOUDFLARE_ACCOUNT_EMAIL"));
      if (apiKey && email) {
        return {
          type: "apiKey" as const,
          apiKey,
          email,
          accountId,
          source: { type: "env" as const },
        };
      }
      return yield* new AuthError({
        message:
          "Cloudflare CI credentials not found. Set CLOUDFLARE_API_TOKEN, or CLOUDFLARE_API_KEY with CLOUDFLARE_EMAIL/CLOUDFLARE_ACCOUNT_EMAIL.",
      });
    });

    const logout = (profileName: string, config: CloudflareAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "stored" }, () =>
            store
              .delete(profileName, STORED_STORAGE_KEY)
              .pipe(
                Effect.andThen(
                  prompt.output.success(
                    "Cloudflare: stored credentials removed",
                  ),
                ),
              ),
          ),
          Match.when({ method: "oauth" }, () =>
            store
              .read(
                profileName,
                OAUTH_STORAGE_KEY,
                OAuthClient.OAuthCredentials,
              )
              .pipe(
                Effect.tap((creds) =>
                  creds?.type === "oauth" &&
                  OAuthClient.usesCurrentClient(creds)
                    ? OAuthClient.revoke(creds).pipe(
                        Effect.catchTag("OAuthError", (err) =>
                          prompt.output.warning(
                            `Cloudflare: could not revoke OAuth token: ${err.errorDescription}`,
                          ),
                        ),
                      )
                    : Effect.void,
                ),
                Effect.andThen(store.delete(profileName, OAUTH_STORAGE_KEY)),
                Effect.andThen(
                  prompt.output.success(
                    "Cloudflare: OAuth credentials removed.",
                  ),
                ),
              ),
          ),
          Match.exhaustive,
        )
        // The cached state-store credentials are derived from the account we
        // just logged out of, so drop them regardless of auth method.
        .pipe(
          Effect.andThen(
            store
              .delete(profileName, STATE_STORE_CREDENTIALS_FILE)
              .pipe(Effect.ignore),
          ),
        );

    const login = (profileName: string, config: CloudflareAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "stored" }, () =>
            store
              .read(
                profileName,
                STORED_STORAGE_KEY,
                CloudflareStoredCredentials,
              )
              .pipe(
                Effect.flatMap((creds) =>
                  creds == null ? loginStored(profileName) : Effect.void,
                ),
              ),
          ),
          Match.when({ method: "oauth" }, (c) =>
            Effect.gen(function* () {
              const creds = yield* store.read(
                profileName,
                OAUTH_STORAGE_KEY,
                OAuthClient.OAuthCredentials,
              );
              const reconfigureCommand = yield* profileCommandHint(
                `alchemy profile edit ${profileName} --reconfigure Cloudflare`,
              );
              // Any path that falls back to a full browser login rebuilds the
              // authorize URL from the profile's stored scopes. Those scopes
              // may predate the current OAuth client (or a catalog change), and
              // one unknown scope makes the whole authorize URL invalid — so
              // sanitize before generating a URL, never after it fails.
              const fullLogin = Effect.suspend(() => {
                const { valid, dropped } = partitionOAuthScopes(c.scopes);
                if (valid.length === 0) {
                  return Effect.fail(
                    new AuthError({
                      message:
                        `The OAuth scopes stored for profile '${profileName}' are no longer offered by Alchemy's Cloudflare OAuth client. ` +
                        `Run \`${reconfigureCommand}\` to pick scopes again.`,
                    }),
                  );
                }
                return (
                  dropped.length === 0
                    ? Effect.void
                    : prompt.output.warning(
                        `Cloudflare: dropping ${dropped.length} stored scope${dropped.length === 1 ? "" : "s"} no longer offered by the current OAuth client (${dropped.join(", ")}). ` +
                          `Run \`${reconfigureCommand}\` to re-pick scopes.`,
                      )
                ).pipe(Effect.andThen(oauthLogin(profileName, valid)));
              });

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
                        .info("Cloudflare: refreshing OAuth credentials...")
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
                                    "Cloudflare: OAuth credentials refreshed.",
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
                          "Cloudflare: removed OAuth credentials issued to the previous client.",
                        );
                      }
                      return "browser" as const;
                    });
              if (outcome === "browser") {
                yield* fullLogin;
              }
            }),
          ),
          Match.exhaustive,
        )
        .pipe(
          // A blanket mapError must never swallow the NeedsReauth tag —
          // the profile UI matches on it to render "needs re-login".
          Effect.mapError((e) =>
            e instanceof NeedsReauth
              ? e
              : new AuthError({ message: "login failed", cause: e }),
          ),
        );

    const details = (profileName: string, config: CloudflareAuthConfig) =>
      Effect.all([
        resolveCredentials(profileName, config),
        Clock.currentTimeMillis,
      ]).pipe(
        Effect.map(([creds, now]) => {
          const source = {
            key: "source",
            value:
              "details" in creds.source && creds.source.details
                ? `${creds.source.type} - ${creds.source.details}`
                : creds.source.type,
          };
          return {
            lines: Match.value(creds).pipe(
              Match.when({ type: "apiToken" }, (c) => [
                { key: "apiToken", value: displayRedacted(c.apiToken, 9) },
                { key: "accountId", value: c.accountId },
                source,
              ]),
              Match.when({ type: "apiKey" }, (c) => [
                { key: "apiKey", value: displayRedacted(c.apiKey) },
                { key: "email", value: displayRedacted(c.email) },
                { key: "accountId", value: c.accountId },
                source,
              ]),
              Match.when({ type: "oauth" }, (c) => {
                const remainingMs = c.expires - now;
                const expiresAt = new Date(c.expires).toISOString();
                const expiresStr =
                  remainingMs <= 0
                    ? `expired (${expiresAt})`
                    : `in ${Duration.format(Duration.millis(remainingMs))} (${expiresAt})`;
                return [
                  { key: "accessToken", value: displayRedacted(c.accessToken) },
                  { key: "expires", value: expiresStr },
                  { key: "accountId", value: c.accountId },
                  source,
                ];
              }),
              Match.exhaustive,
            ),
          };
        }),
      );

    /**
     * Persist flag-provided stored credentials (`--method api-token` /
     * `--method api-key`). Writes the same `cloudflare-stored` file the
     * interactive stored path writes; OAuth is interactive-only and not
     * accepted here.
     */
    const configureWith = (
      profileName: string,
      input: {
        readonly method: string;
        readonly values: Record<string, string>;
      },
    ): Effect.Effect<CloudflareAuthConfig, AuthError> => {
      const persist = (
        credentials: CloudflareStoredCredentials,
        config: CloudflareAuthConfig,
      ) =>
        store
          .write(
            profileName,
            STORED_STORAGE_KEY,
            CloudflareStoredCredentials,
            credentials,
          )
          .pipe(
            // Re-configuring may point this profile at a different
            // Cloudflare account; the cached state-store credentials are
            // minted per-account, so drop them (same as `configure`).
            Effect.andThen(
              store
                .delete(profileName, STATE_STORE_CREDENTIALS_FILE)
                .pipe(Effect.ignore),
            ),
            Effect.as(config),
          );
      return Match.value(input.method).pipe(
        Match.when("api-token", () =>
          validateFieldValues(
            CLOUDFLARE_AUTH_PROVIDER_NAME,
            apiTokenFields,
            input.values,
          ).pipe(
            Effect.flatMap((values) =>
              persist(
                {
                  type: "apiToken",
                  apiToken: storedSecret(values.apiToken) ?? Redacted.make(""),
                  accountId: (storedValueText(values.accountId) ?? "")
                    .trim()
                    .toLowerCase(),
                },
                { method: "stored", credentialType: "apiToken" },
              ),
            ),
          ),
        ),
        Match.when("api-key", () =>
          validateFieldValues(
            CLOUDFLARE_AUTH_PROVIDER_NAME,
            apiKeyFields,
            input.values,
          ).pipe(
            Effect.flatMap((values) =>
              persist(
                {
                  type: "apiKey",
                  apiKey: storedSecret(values.apiKey) ?? Redacted.make(""),
                  email: storedSecret(values.email) ?? Redacted.make(""),
                  accountId: (storedValueText(values.accountId) ?? "")
                    .trim()
                    .toLowerCase(),
                },
                { method: "stored", credentialType: "apiKey" },
              ),
            ),
          ),
        ),
        Match.orElse(() =>
          Effect.fail(
            new AuthError({
              message: `Cloudflare: unknown method '${input.method}'. Valid methods: api-token, api-key. (OAuth is interactive-only.)`,
            }),
          ),
        ),
      );
    };

    return {
      configSchema: CloudflareAuthConfigSchema,
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
          name: "CLOUDFLARE_ACCOUNT_ID",
          required: true,
          description: "Account the stack deploys into.",
        },
        {
          name: "CLOUDFLARE_API_TOKEN",
          required: true,
          secret: true,
          alternatives: ["CLOUDFLARE_API_KEY"],
          description:
            "API token (preferred). Not consulted when unset and CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL are provided instead.",
        },
        {
          name: "CLOUDFLARE_API_KEY",
          required: false,
          secret: true,
          description:
            "Global API key; used with CLOUDFLARE_EMAIL when no API token is set.",
        },
        {
          name: "CLOUDFLARE_EMAIL",
          required: false,
          alternatives: ["CLOUDFLARE_ACCOUNT_EMAIL"],
          description: "Account email paired with CLOUDFLARE_API_KEY.",
        },
      ],
    };
  }),
);
