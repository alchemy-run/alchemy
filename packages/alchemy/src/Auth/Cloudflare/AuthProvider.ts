import * as p from "@clack/prompts";
import * as cfAccounts from "@distilled.cloud/cloudflare/accounts";
import * as CfCredentialsModule from "@distilled.cloud/cloudflare/Credentials";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { StageConfig } from "../../Cloudflare/StageConfig.ts";
import type { AuthProvider } from "../AuthProvider.ts";
import {
  credentialsFilePath,
  deleteCredentials,
  displayRedacted,
  readCredentials,
  writeCredentials,
} from "../Credentials.ts";
import { openUrl } from "../openUrl.ts";
import { prompt } from "../Prompt.ts";
import * as OAuthClient from "./OAuthClient.ts";
import { ALL_SCOPES, DEFAULT_SCOPES } from "./Scopes.ts";

export type { OAuthCredentials } from "./OAuthClient.ts";
export { ALL_SCOPES, DEFAULT_SCOPES } from "./Scopes.ts";
export { OAuthClient };

export type CloudflareAuthConfig =
  | { method: "env"; accountId?: string }
  | { method: "stored"; credentialType: "apiToken"; accountId?: string }
  | { method: "stored"; credentialType: "apiKey"; accountId?: string }
  | { method: "oauth"; scopes: string[]; accountId?: string };

export type CloudflareStoredCredentials =
  | { type: "apiToken"; apiToken: string }
  | { type: "apiKey"; apiKey: string; email: string }
  | OAuthClient.OAuthCredentials;

export type CloudflareResolvedCredentials =
  | {
      type: "apiToken";
      apiToken: Redacted.Redacted<string>;
      source: string;
    }
  | {
      type: "apiKey";
      apiKey: Redacted.Redacted<string>;
      email: string;
      source: string;
    }
  | {
      type: "oauth";
      accessToken: Redacted.Redacted<string>;
      expires: number;
      source: string;
    };

const optionalRedacted = (
  key: string,
): Effect.Effect<Redacted.Redacted<string> | undefined> =>
  Config.option(Config.redacted(key))
    .asEffect()
    .pipe(Effect.map(Option.getOrUndefined), Effect.orDie);

const optionalString = (key: string): Effect.Effect<string | undefined> =>
  Config.option(Config.string(key))
    .asEffect()
    .pipe(Effect.map(Option.getOrUndefined), Effect.orDie);

export const resolveFromEnv: Effect.Effect<
  CloudflareResolvedCredentials | undefined
> = Effect.gen(function* () {
  const apiToken = yield* optionalRedacted("CLOUDFLARE_API_TOKEN");
  if (apiToken) {
    return {
      type: "apiToken" as const,
      apiToken,
      source: "environment variables",
    };
  }
  const apiKey = yield* optionalRedacted("CLOUDFLARE_API_KEY");
  const email = yield* optionalString("CLOUDFLARE_EMAIL");
  if (apiKey && email) {
    return {
      type: "apiKey" as const,
      apiKey,
      email,
      source: "environment variables",
    };
  }
  return undefined;
});

/**
 * Prompt for Cloudflare Account ID.
 * Returns:
 *   - `undefined` — user cancelled (Ctrl+C / escape)
 *   - `""`        — user skipped (Enter with no value); proceed without one
 *   - a string   — account id to use
 */
const promptAccountId = (): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const envAccountId = yield* optionalString("CLOUDFLARE_ACCOUNT_ID");
    return yield* prompt(() =>
      p.text({
        message: "Cloudflare Account ID (Enter to skip)",
        placeholder: envAccountId ?? "",
        defaultValue: envAccountId ?? "",
      }),
    );
  });

const promptOAuthScopes = (): Effect.Effect<string[] | undefined> =>
  Effect.gen(function* () {
    const customize = yield* prompt(() =>
      p.confirm({
        message: "Customize OAuth scopes? (default covers typical use cases)",
        initialValue: false,
      }),
    );
    if (customize === undefined) return undefined;

    if (!customize) return [...DEFAULT_SCOPES];

    const selected = yield* prompt(() =>
      p.multiselect({
        message: "Select OAuth scopes",
        initialValues: DEFAULT_SCOPES as string[],
        options: Object.entries(ALL_SCOPES).map(([value, hint]) => ({
          value: value as string,
          label: value,
          hint,
        })),
        required: true,
      }),
    );
    if (selected === undefined) return undefined;
    return selected as string[];
  });

// ── Cloudflare Accounts API ──────────────────────────────────────────

/**
 * Provide a temporary Credentials + HttpClient layer from a raw OAuth
 * access token so we can call the distilled SDK outside of a full stack.
 */
const withOAuthCredentials = <A, E>(
  accessToken: string,
  effect: Effect.Effect<
    A,
    E,
    | CfCredentialsModule.Credentials
    | import("effect/unstable/http/HttpClient").HttpClient
  >,
): Effect.Effect<A, E> =>
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

const selectAccount = (
  accessToken: string,
): Effect.Effect<string | undefined, cfAccounts.ListAccountsError> =>
  Effect.gen(function* () {
    const list = yield* cfAccounts.listAccounts;
    const response = yield* list({});
    const accounts = response.result;
    if (accounts.length === 0) {
      yield* Effect.sync(() =>
        p.log.warn("No Cloudflare accounts found for this credential."),
      );
      return undefined;
    }
    if (accounts.length === 1) {
      const account = accounts[0]!;
      yield* Effect.sync(() =>
        p.log.info(`Using account: ${account.name} (${account.id})`),
      );
      return account.id;
    }
    const selected = yield* prompt(() =>
      p.select({
        message: "Select a Cloudflare account",
        options: accounts.map((a) => ({
          value: a.id,
          label: a.name,
          hint: a.id,
        })),
      }),
    );
    if (selected === undefined) return undefined;
    return selected;
  }).pipe((effect) => withOAuthCredentials(accessToken, effect));

const matchMethod = Match.discriminator("method");

const printAccountId = (
  accountId: string | undefined,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const envAccountId = yield* optionalString("CLOUDFLARE_ACCOUNT_ID");
    const resolved = accountId ?? envAccountId;
    yield* Console.log(
      `  accountId: ${resolved ?? "(not set — configure or set CLOUDFLARE_ACCOUNT_ID)"}`,
    );
  });

const printCredentials = (creds: CloudflareResolvedCredentials) =>
  Effect.gen(function* () {
    yield* Match.value(creds).pipe(
      Match.when({ type: "apiToken" }, (c) =>
        Console.log(`  apiToken: ${displayRedacted(c.apiToken, 9)}`),
      ),
      Match.when({ type: "apiKey" }, (c) =>
        Effect.gen(function* () {
          yield* Console.log(`  apiKey: ${displayRedacted(c.apiKey)}`);
          yield* Console.log(`  email:  ${c.email}`);
        }),
      ),
      Match.when({ type: "oauth" }, (c) =>
        Effect.gen(function* () {
          yield* Console.log(`  accessToken: ${displayRedacted(c.accessToken)}`);
          const remainingMs = c.expires - Date.now();
          const expiresAt = new Date(c.expires).toISOString();
          if (remainingMs <= 0) {
            yield* Console.log(`  expires: expired (${expiresAt})`);
          } else {
            const pretty = Duration.format(Duration.millis(remainingMs));
            yield* Console.log(`  expires: in ${pretty} (${expiresAt})`);
          }
        }),
      ),
      Match.exhaustive,
    );
    yield* Console.log(`  source: ${creds.source}`);
  });

/**
 * Single implementation of the Cloudflare AuthProvider. Exposed as an
 * Effect that captures platform services (FileSystem, ChildProcessSpawner)
 * and returns an AuthProvider whose methods carry no requirements.
 */
export const CfAuth: Effect.Effect<
  AuthProvider<CloudflareAuthConfig, CfCredentialsModule.Credentials>,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const context = yield* Effect.context<
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  >();

  const oauthLogin = (
    profileName: string,
    scopes: string[],
  ): Effect.Effect<OAuthClient.OAuthCredentials | undefined> =>
    Effect.gen(function* () {
        const allScopes = [...scopes, "offline_access"];
        const authorization = OAuthClient.authorize(allScopes);

        yield* Effect.sync(() =>
          p.log.info("Opening browser for Cloudflare OAuth login..."),
        );
        yield* Effect.sync(() => p.log.info(authorization.url));

        yield* openUrl(authorization.url).pipe(
          Effect.catch(() =>
            Effect.sync(() =>
              p.log.warn(
                "Could not open browser automatically. Please open the URL above manually.",
              ),
            ),
          ),
        );

        yield* Effect.sync(() =>
          p.log.info("Waiting for authorization (up to 5 minutes)..."),
        );

        const credentials = yield* OAuthClient.callback(authorization);

        yield* writeCredentials(profileName, "cloudflare", credentials);
        yield* Effect.sync(() =>
          p.log.success("Cloudflare OAuth credentials saved."),
        );
        return credentials;
      }).pipe(
        Effect.catchTag("OAuthError", (err) =>
          Effect.sync(() => {
            p.log.error(`OAuth login failed: ${err.errorDescription}`);
            return undefined;
          }),
        ),
        Effect.provideContext(context),
        Effect.orDie,
      );

  const oauthProvider = (
    profileName: string,
    creds: OAuthClient.OAuthCredentials,
  ): CfCredentialsModule.OAuthProvider<FileSystem.FileSystem> => ({
    load: Effect.succeed({
      accessToken: creds.access,
      refreshToken: creds.refresh,
      expiresAt: creds.expires,
    }),
    refresh: (current) =>
      Effect.gen(function* () {
        if (!current.refreshToken) {
          return yield* Effect.fail(
            new OAuthClient.OAuthError({
              error: "no_refresh_token",
              errorDescription:
                "No Cloudflare OAuth refresh token available. Run: alchemy-effect login",
            }),
          );
        }
        const refreshed = yield* OAuthClient.refresh({
          type: "oauth",
          access: current.accessToken,
          refresh: current.refreshToken,
          expires: current.expiresAt ?? 0,
          scopes: creds.scopes,
        }).pipe(
          Effect.mapError(
            (err) =>
              new OAuthClient.OAuthError({
                error: err.error,
                errorDescription: `${err.errorDescription} — Run: alchemy-effect login`,
              }),
          ),
        );
        yield* writeCredentials(profileName, "cloudflare", refreshed).pipe(
          Effect.catch(() => Effect.void),
        );
        return {
          accessToken: refreshed.access,
          refreshToken: refreshed.refresh,
          expiresAt: refreshed.expires,
        };
      }),
  });

  const resolveFromStored = (
    profileName: string,
  ): Effect.Effect<CloudflareResolvedCredentials | undefined> =>
    Effect.gen(function* () {
        const creds = yield* readCredentials<CloudflareStoredCredentials>(
          profileName,
          "cloudflare",
        );
        if (!creds) return undefined;
        const source = credentialsFilePath(profileName, "cloudflare");
        return Match.value(creds).pipe(
          Match.when({ type: "apiToken" }, (c) => ({
            type: "apiToken" as const,
            apiToken: Redacted.make(c.apiToken),
            source,
          })),
          Match.when({ type: "apiKey" }, (c) => ({
            type: "apiKey" as const,
            apiKey: Redacted.make(c.apiKey),
            email: c.email,
            source,
          })),
          Match.when({ type: "oauth" }, (c) => ({
            type: "oauth" as const,
            accessToken: Redacted.make(c.access),
            expires: c.expires,
            source,
          })),
          Match.exhaustive,
        );
      }).pipe(Effect.provideContext(context));

  return {
    name: "Cloudflare",

    configure: (profileName, isReconfigure = false) =>
      Effect.orDie(
        Effect.gen(function* () {
            const options: {
              value: "oauth" | "env" | "stored" | "remove";
              label: string;
              hint?: string;
            }[] = [
              {
                value: "oauth",
                label: "OAuth",
                hint: "recommended — browser-based login with automatic token refresh",
              },
              {
                value: "env",
                label: "Environment Variables",
                hint: "CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL",
              },
              {
                value: "stored",
                label: "Stored",
                hint: "stored in ~/.alchemy/credentials",
              },
            ];
            if (isReconfigure) {
              options.push({
                value: "remove",
                label: "Remove",
                hint: "remove Cloudflare from this profile",
              });
            }

            const method = yield* prompt(() =>
              p.select({
                message: "Cloudflare authentication method",
                options,
              }),
            );
            if (method === undefined) return undefined;

            return yield* Match.value(method).pipe(
              Match.when("remove", () => Effect.succeed("remove" as const)),
              Match.when("oauth", () =>
                Effect.gen(function* () {
                  const scopes = yield* promptOAuthScopes();
                  if (scopes === undefined) return undefined;

                  const oauthCreds = yield* oauthLogin(profileName, scopes);
                  if (!oauthCreds) return undefined;

                  const accountId = yield* selectAccount(
                    oauthCreds.access,
                  ).pipe(
                    Effect.catch((err) =>
                      Effect.sync(() => {
                        p.log.warn(
                          `Could not list accounts: ${err}. You can set CLOUDFLARE_ACCOUNT_ID instead.`,
                        );
                        return undefined;
                      }),
                    ),
                  );
                  if (accountId === undefined) return undefined;
                  return {
                    method: "oauth" as const,
                    scopes,
                    ...(accountId ? { accountId } : {}),
                  };
                }),
              ),
              Match.when("env", () =>
                Effect.gen(function* () {
                  const accountId = yield* promptAccountId();
                  if (accountId === undefined) return undefined;
                  return {
                    method: "env" as const,
                    ...(accountId ? { accountId } : {}),
                  };
                }),
              ),
              Match.when("stored", () =>
                Effect.gen(function* () {
                  const credentialType = yield* prompt(() =>
                    p.select({
                      message: "Cloudflare credential type",
                      options: [
                        {
                          value: "apiToken" as const,
                          label: "API Token",
                          hint: "recommended",
                        },
                        {
                          value: "apiKey" as const,
                          label: "API Key + Email",
                        },
                      ],
                    }),
                  );
                  if (credentialType === undefined) return undefined;

                  return yield* Match.value(credentialType).pipe(
                    Match.when("apiToken", () =>
                      Effect.gen(function* () {
                        const apiToken = yield* prompt(() =>
                          p.password({
                            message: "Cloudflare API Token",
                            validate: (v) =>
                              v.length === 0 ? "Required" : undefined,
                          }),
                        );
                        if (apiToken === undefined) return undefined;

                        yield* writeCredentials<CloudflareStoredCredentials>(
                          profileName,
                          "cloudflare",
                          { type: "apiToken", apiToken },
                        );
                        yield* Effect.sync(() =>
                          p.log.success("Cloudflare credentials saved."),
                        );
                        const accountId = yield* promptAccountId();
                        if (accountId === undefined) return undefined;
                        return {
                          method: "stored" as const,
                          credentialType: "apiToken" as const,
                          ...(accountId ? { accountId } : {}),
                        };
                      }),
                    ),
                    Match.when("apiKey", () =>
                      Effect.gen(function* () {
                        const apiKey = yield* prompt(() =>
                          p.text({
                            message: "Cloudflare API Key",
                            validate: (v) =>
                              v.length === 0 ? "Required" : undefined,
                          }),
                        );
                        if (apiKey === undefined) return undefined;

                        const email = yield* prompt(() =>
                          p.text({
                            message: "Cloudflare Email",
                            validate: (v) =>
                              v.length === 0 ? "Required" : undefined,
                          }),
                        );
                        if (email === undefined) return undefined;

                        yield* writeCredentials<CloudflareStoredCredentials>(
                          profileName,
                          "cloudflare",
                          { type: "apiKey", apiKey, email },
                        );
                        yield* Effect.sync(() =>
                          p.log.success("Cloudflare credentials saved."),
                        );
                        const accountId = yield* promptAccountId();
                        if (accountId === undefined) return undefined;
                        return {
                          method: "stored" as const,
                          credentialType: "apiKey" as const,
                          ...(accountId ? { accountId } : {}),
                        };
                      }),
                    ),
                    Match.exhaustive,
                  );
                }),
              ),
              Match.exhaustive,
            );
          }).pipe(Effect.provideContext(context)),
      ),

    login: (profileName, config) =>
      Effect.orDie(
        Match.value(config).pipe(
            matchMethod("env", () =>
              Effect.sync(() =>
                p.log.info(
                  "Cloudflare: using environment variables — no login required.",
                ),
              ),
            ),
            matchMethod("stored", () =>
              Effect.sync(() =>
                p.log.info(
                  "Cloudflare: using stored credentials — no login required.",
                ),
              ),
            ),
            matchMethod("oauth", (c) =>
              Effect.gen(function* () {
                const creds =
                  yield* readCredentials<OAuthClient.OAuthCredentials>(
                    profileName,
                    "cloudflare",
                  );
                if (
                  creds?.type === "oauth" &&
                  creds.expires > Date.now() + 10_000
                ) {
                  yield* Effect.sync(() =>
                    p.log.info("Cloudflare: OAuth credentials are still valid."),
                  );
                  return;
                }
                if (creds?.type === "oauth") {
                  yield* Effect.sync(() =>
                    p.log.info("Cloudflare: refreshing OAuth credentials..."),
                  );
                  const refreshed = yield* OAuthClient.refresh(creds).pipe(
                    Effect.catchTag("OAuthError", () =>
                      Effect.succeed(undefined),
                    ),
                  );
                  if (refreshed) {
                    yield* writeCredentials(
                      profileName,
                      "cloudflare",
                      refreshed,
                    );
                    yield* Effect.sync(() =>
                      p.log.success("Cloudflare OAuth credentials refreshed."),
                    );
                    return;
                  }
                }
                yield* oauthLogin(profileName, c.scopes);
              }),
            ),
            Match.exhaustive,
            Effect.provideContext(context),
          ),
      ),

    logout: (profileName, config) =>
      Match.value(config).pipe(
          matchMethod("stored", () =>
            Effect.gen(function* () {
              yield* deleteCredentials(profileName, "cloudflare");
              yield* Effect.sync(() =>
                p.log.success("Cloudflare stored credentials removed."),
              );
            }),
          ),
          matchMethod("env", () =>
            Effect.sync(() =>
              p.log.info(
                "Cloudflare: using environment variables — nothing to log out of.",
              ),
            ),
          ),
          matchMethod("oauth", () =>
            Effect.gen(function* () {
              const creds =
                yield* readCredentials<OAuthClient.OAuthCredentials>(
                  profileName,
                  "cloudflare",
                );
              if (creds?.type === "oauth") {
                yield* OAuthClient.revoke(creds).pipe(
                  Effect.catchTag("OAuthError", (err) =>
                    Effect.sync(() =>
                      p.log.warn(
                        `Could not revoke OAuth token: ${err.errorDescription}`,
                      ),
                    ),
                  ),
                );
              }
              yield* deleteCredentials(profileName, "cloudflare");
              yield* Effect.sync(() =>
                p.log.success("Cloudflare OAuth credentials removed."),
              );
            }),
          ),
          Match.exhaustive,
          Effect.provideContext(context),
        ),

    prettyPrint: (profileName, config) =>
      Match.value(config).pipe(
        matchMethod("env", (c) =>
          Effect.gen(function* () {
            yield* Console.log("Cloudflare: env");
            const resolved = yield* resolveFromEnv;
            if (!resolved) {
              yield* Console.log("  CLOUDFLARE_API_TOKEN: (not set)");
              yield* Console.log("  CLOUDFLARE_API_KEY:   (not set)");
              yield* Console.log("  CLOUDFLARE_EMAIL:     (not set)");
            } else {
              yield* printCredentials(resolved);
            }
            yield* printAccountId(c.accountId);
          }),
        ),
        matchMethod("stored", (c) =>
          Effect.gen(function* () {
            yield* Console.log(`Cloudflare: stored (${c.credentialType})`);
            const resolved = yield* resolveFromStored(profileName);
            if (!resolved) {
              yield* Console.log(
                "  ERROR: credentials not found. Run: alchemy-effect login --configure",
              );
            } else {
              yield* printCredentials(resolved);
            }
            yield* printAccountId(c.accountId);
          }),
        ),
        matchMethod("oauth", (c) =>
          Effect.gen(function* () {
            yield* Console.log("Cloudflare: oauth (SSO)");
            const resolved = yield* resolveFromStored(profileName);
            if (!resolved) {
              yield* Console.log(
                "  ERROR: credentials not found. Run: alchemy-effect login",
              );
            } else {
              yield* printCredentials(resolved);
            }
            yield* Console.log(`  scopes: ${c.scopes.join(", ")}`);
            yield* printAccountId(c.accountId);
          }),
        ),
        Match.exhaustive,
      ),

    credentialsLayer: (profileName, config) =>
      Match.value(config).pipe(
        matchMethod("env", () => CfCredentialsModule.fromEnv()),
        matchMethod("stored", () =>
          Layer.unwrap(
            readCredentials<CloudflareStoredCredentials>(
              profileName,
              "cloudflare",
            ).pipe(
              Effect.map((creds) => {
                if (!creds) {
                  return Layer.effectDiscard(
                    Effect.die(
                      "Cloudflare stored credentials not found. Run: alchemy-effect login --configure",
                    ),
                  ) as Layer.Layer<CfCredentialsModule.Credentials>;
                }
                return Match.value(creds).pipe(
                  Match.when({ type: "apiToken" }, (c) =>
                    CfCredentialsModule.fromApiToken({
                      apiToken: c.apiToken,
                    }),
                  ),
                  Match.when({ type: "apiKey" }, (c) =>
                    CfCredentialsModule.fromApiKey({
                      apiKey: c.apiKey,
                      email: c.email,
                    }),
                  ),
                  Match.when({ type: "oauth" }, (c) =>
                    CfCredentialsModule.fromOAuth(
                      oauthProvider(profileName, c),
                    ),
                  ),
                  Match.exhaustive,
                );
              }),
            ),
          ).pipe(Layer.provide(Layer.succeedContext(context))),
        ),
        matchMethod("oauth", () =>
          Layer.unwrap(
            readCredentials<OAuthClient.OAuthCredentials>(
              profileName,
              "cloudflare",
            ).pipe(
              Effect.map((creds) => {
                if (!creds || creds.type !== "oauth") {
                  return Layer.effectDiscard(
                    Effect.die(
                      "Cloudflare OAuth credentials not found. Run: alchemy-effect login",
                    ),
                  ) as Layer.Layer<CfCredentialsModule.Credentials>;
                }
                return CfCredentialsModule.fromOAuth(
                  oauthProvider(profileName, creds),
                );
              }),
            ),
          ).pipe(Layer.provide(Layer.succeedContext(context))),
        ),
        Match.exhaustive,
      ),
  } satisfies AuthProvider<CloudflareAuthConfig, CfCredentialsModule.Credentials>;
});

export const stageConfigLayer = (
  config: CloudflareAuthConfig,
): Layer.Layer<StageConfig> =>
  Layer.succeed(StageConfig, {
    account: config.accountId,
  });
