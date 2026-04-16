import * as cfAccounts from "@distilled.cloud/cloudflare/accounts";
import * as CfCredentialsModule from "@distilled.cloud/cloudflare/Credentials";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { AuthError, type AuthProvider } from "../AuthProvider.ts";
import * as Clank from "../Clank.ts";
import {
  deleteCredentials,
  displayRedacted,
  readCredentials,
  writeCredentials,
} from "../Credentials.ts";
import { getEnv, getEnvRedacted, retryOnce } from "../util.ts";
import * as OAuthClient from "./OAuthClient.ts";
import { ALL_SCOPES, DEFAULT_SCOPES } from "./Scopes.ts";

export type CloudflareAuthConfig =
  | { method: "env"; accountId?: string }
  | { method: "stored"; credentialType: "apiToken"; accountId?: string }
  | { method: "stored"; credentialType: "apiKey"; accountId?: string }
  | { method: "oauth"; scopes: string[]; accountId?: string };

const options: Array<{
  value: CloudflareAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
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

export type CloudflareStoredCredentials =
  | { type: "apiToken"; apiToken: string }
  | { type: "apiKey"; apiKey: string; email: string };

export type CloudflareResolvedCredentials =
  | {
      type: "apiToken";
      apiToken: Redacted.Redacted<string>;
      source: { type: CloudflareAuthConfig["method"]; details?: string };
    }
  | {
      type: "apiKey";
      apiKey: Redacted.Redacted<string>;
      email: Redacted.Redacted<string>;
      source: { type: CloudflareAuthConfig["method"]; details?: string };
    }
  | {
      type: "oauth";
      accessToken: Redacted.Redacted<string>;
      expires: number;
      source: { type: CloudflareAuthConfig["method"]; details?: string };
    };

export const CloudflareAuth = Effect.gen(function* () {
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();

  return {
    name: "Cloudflare",

    configure: (profileName) =>
      configureCredentials(profileName).pipe(Effect.provide(context)),

    logout: (profileName, config) =>
      logout(profileName, config).pipe(Effect.provide(context)),

    login: (profileName, config) =>
      login(profileName, config).pipe(Effect.provide(context)),

    prettyPrint: (profileName, config) =>
      prettyPrint(profileName, config).pipe(Effect.provide(context)),

    read: (profileName, config) =>
      resolveCredentials(profileName, config).pipe(Effect.provide(context)),
  } satisfies AuthProvider<CloudflareAuthConfig, CloudflareResolvedCredentials>;
});

const resolveCredentials = (
  profileName: string,
  config: CloudflareAuthConfig,
) =>
  Match.value(config).pipe(
    Match.when(
      { method: "env" },
      Effect.fnUntraced(function* () {
        const apiToken = yield* getEnvRedacted("CLOUDFLARE_API_TOKEN");
        if (apiToken) {
          return {
            type: "apiToken" as const,
            apiToken,
            source: { type: "env" },
          } as CloudflareResolvedCredentials;
        }
        const apiKey = yield* getEnvRedacted("CLOUDFLARE_API_KEY");
        const email = yield* getEnvRedacted("CLOUDFLARE_EMAIL");
        if (apiKey && email) {
          return {
            type: "apiKey" as const,
            apiKey,
            email,
            source: { type: "env" },
          } as CloudflareResolvedCredentials;
        }
        return yield* new AuthError({
          message:
            "Cloudflare env credentials not found. Set CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL.",
        });
      }),
    ),
    Match.when({ method: "stored" }, () =>
      readCredentials<CloudflareStoredCredentials>(
        profileName,
        "cf-stored",
      ).pipe(
        Effect.flatMap((creds) =>
          creds == null
            ? Effect.fail(
                new AuthError({
                  message:
                    "Cloudflare stored credentials not found. Run: alchemy-effect login --configure",
                }),
              )
            : Effect.succeed(
                Match.value(creds).pipe(
                  Match.when({ type: "apiToken" }, (c) => ({
                    type: "apiToken" as const,
                    apiToken: Redacted.make(c.apiToken),
                    source: { type: "stored" as const },
                  })),
                  Match.when({ type: "apiKey" }, (c) => ({
                    type: "apiKey" as const,
                    apiKey: Redacted.make(c.apiKey),
                    email: Redacted.make(c.email),
                    source: { type: "stored" as const },
                  })),
                  Match.exhaustive,
                ) as CloudflareResolvedCredentials,
              ),
        ),
      ),
    ),
    Match.when({ method: "oauth" }, () =>
      readCredentials<OAuthClient.OAuthCredentials>(
        profileName,
        "cf-oauth",
      ).pipe(
        Effect.flatMap((creds) =>
          creds == null || creds.type !== "oauth"
            ? Effect.fail(
                new AuthError({
                  message:
                    "Cloudflare OAuth credentials not found. Run: alchemy-effect login",
                }),
              )
            : Effect.succeed({
                type: "oauth" as const,
                accessToken: Redacted.make(creds.access),
                expires: creds.expires,
                source: { type: "oauth" as const },
              } as CloudflareResolvedCredentials),
        ),
      ),
    ),
    Match.exhaustive,
  );

const logout = (profileName: string, config: CloudflareAuthConfig) =>
  Match.value(config).pipe(
    Match.when({ method: "env" }, () => Effect.void),
    Match.when({ method: "stored" }, () =>
      deleteCredentials(profileName, "cf-stored").pipe(
        Effect.andThen(Clank.success("Cloudflare: stored credentials removed")),
      ),
    ),
    Match.when({ method: "oauth" }, () =>
      readCredentials<OAuthClient.OAuthCredentials>(
        profileName,
        "cf-oauth",
      ).pipe(
        Effect.tap((creds) =>
          creds?.type === "oauth"
            ? OAuthClient.revoke(creds).pipe(
                Effect.catchTag("OAuthError", (err) =>
                  Clank.warn(
                    `Cloudflare: could not revoke OAuth token: ${err.errorDescription}`,
                  ),
                ),
              )
            : Effect.void,
        ),
        Effect.andThen(deleteCredentials(profileName, "cf-oauth")),
        Effect.andThen(Clank.success("Cloudflare: OAuth credentials removed.")),
      ),
    ),
    Match.exhaustive,
  );

const login = (profileName: string, config: CloudflareAuthConfig) =>
  Match.value(config)
    .pipe(
      Match.when({ method: "env" }, () => Effect.void),
      Match.when({ method: "stored" }, () =>
        readCredentials<CloudflareStoredCredentials>(
          profileName,
          "cf-stored",
        ).pipe(
          Effect.flatMap((creds) =>
            creds == null ? loginStored(profileName) : Effect.void,
          ),
        ),
      ),
      Match.when({ method: "oauth" }, (c) =>
        Effect.gen(function* () {
          const creds = yield* readCredentials<OAuthClient.OAuthCredentials>(
            profileName,
            "cf-oauth",
          );

          if (creds?.type === "oauth" && creds.expires > Date.now() + 10_000) {
            yield* Clank.info("Cloudflare: OAuth credentials are still valid.");
            return;
          }

          if (creds?.type === "oauth") {
            yield* Clank.info("Cloudflare: refreshing OAuth credentials...");
            yield* OAuthClient.refresh(creds).pipe(
              Effect.flatMap((refreshed) =>
                writeCredentials(profileName, "cf-oauth", refreshed).pipe(
                  Effect.andThen(
                    Clank.success("Cloudflare: OAuth credentials refreshed."),
                  ),
                ),
              ),
              Effect.catchTag("OAuthError", () =>
                oauthLogin(profileName, c.scopes).pipe(Effect.asVoid),
              ),
            );
            return;
          }

          yield* oauthLogin(profileName, c.scopes);
        }),
      ),
      Match.exhaustive,
    )
    .pipe(
      Effect.mapError(
        (e) => new AuthError({ message: "login failed", cause: e }),
      ),
    );

const configureCredentials = (profileName: string) =>
  Clank.select({
    message: "Cloudflare authentication method",
    options,
  })
    .pipe(
      Effect.flatMap((method) =>
        Match.value(method).pipe(
          Match.when("env", () => Effect.succeed({ method: "env" as const })),
          Match.when("oauth", () => configureOAuth(profileName)),
          Match.when("stored", () => loginStored(profileName)),
          Match.exhaustive,
        ),
      ),
    )
    .pipe(
      Effect.mapError(
        (e) =>
          new AuthError({
            message: "failed to configure credentials",
            cause: e,
          }),
      ),
    );

const configureOAuth = Effect.fnUntraced(function* (profileName: string) {
  const scopes = yield* promptOAuthScopes();

  const oauthCreds = yield* oauthLogin(profileName, scopes);

  const accountId = yield* selectAccount(oauthCreds.access).pipe(
    Effect.mapError(
      (e) =>
        new AuthError({
          message: "Cloudflare: could not list accounts",
          cause: e,
        }),
    ),
  );

  return {
    method: "oauth" as const,
    scopes,
    accountId,
  };
});

const loginStored = Effect.fnUntraced(function* (profileName: string) {
  const credentialType = yield* Clank.select({
    message: "Cloudflare credential type",
    options: [
      { value: "apiToken" as const, label: "API Token", hint: "recommended" },
      { value: "apiKey" as const, label: "API Key + Email" },
    ],
  }).pipe(retryOnce);

  return yield* Match.value(credentialType).pipe(
    Match.when("apiToken", () =>
      Effect.gen(function* () {
        const apiToken = yield* Clank.password({
          message: "Cloudflare API Token",
          validate: (v) => (v.length === 0 ? "Required" : undefined),
        }).pipe(retryOnce);

        yield* writeCredentials<CloudflareStoredCredentials>(
          profileName,
          "cf-stored",
          { type: "apiToken", apiToken },
        );
        yield* Clank.success("Cloudflare: credentials saved.");
        const accountId = yield* promptAccountId();
        return {
          method: "stored" as const,
          credentialType: "apiToken" as const,
          ...(accountId ? { accountId } : {}),
        };
      }),
    ),
    Match.when("apiKey", () =>
      Effect.gen(function* () {
        const apiKey = yield* Clank.text({
          message: "Cloudflare API Key",
          validate: (v) => (v.length === 0 ? "Required" : undefined),
        }).pipe(retryOnce);

        const email = yield* Clank.text({
          message: "Cloudflare Email",
          validate: (v) => (v.length === 0 ? "Required" : undefined),
        }).pipe(retryOnce);

        yield* writeCredentials<CloudflareStoredCredentials>(
          profileName,
          "cf-stored",
          { type: "apiKey", apiKey, email },
        );
        yield* Clank.success("Cloudflare: credentials saved.");
        const accountId = yield* promptAccountId();
        return {
          method: "stored" as const,
          credentialType: "apiKey" as const,
          ...(accountId ? { accountId } : {}),
        };
      }),
    ),
    Match.exhaustive,
  );
});

const oauthLogin = (profileName: string, scopes: string[]) =>
  Effect.gen(function* () {
    const authorization = OAuthClient.authorize([...scopes, "offline_access"]);

    yield* Clank.info("Cloudflare: opening browser for OAuth login...");
    yield* Clank.info(authorization.url);
    yield* Clank.openUrl(authorization.url).pipe(
      Effect.catch(() =>
        Clank.warn(
          "Cloudflare: could not open browser automatically. Please open the URL above manually.",
        ),
      ),
    );
    yield* Clank.info(
      "Cloudflare: waiting for authorization (up to 5 minutes)...",
    );

    const credentials = yield* OAuthClient.callback(authorization);
    yield* writeCredentials(profileName, "cf-oauth", credentials);
    yield* Clank.success("Cloudflare: OAuth credentials saved.");
    return credentials;
  });

const promptAccountId = () =>
  getEnv("CLOUDFLARE_ACCOUNT_ID").pipe(
    Effect.flatMap((envAccountId) =>
      Clank.text({
        message: "Cloudflare Account ID (Enter to skip)",
        placeholder: envAccountId ?? "",
        defaultValue: envAccountId ?? "",
      }).pipe(retryOnce),
    ),
  );

const promptOAuthScopes = () =>
  Clank.confirm({
    message: "Customize OAuth scopes? (default covers typical use cases)",
    initialValue: false,
  }).pipe(
    retryOnce,
    Effect.flatMap((customize) => {
      if (!customize) return Effect.succeed([...DEFAULT_SCOPES]);
      return Clank.multiselect({
        message: "Select OAuth scopes",
        initialValues: DEFAULT_SCOPES as string[],
        options: Object.entries(ALL_SCOPES).map(([value, hint]) => ({
          value: value as string,
          label: value,
          hint,
        })),
        required: true,
      }).pipe(
        Effect.map((s) => s as string[]),
        retryOnce,
      );
    }),
  );

const withOAuthCredentials = <A, E>(
  accessToken: string,
  effect: Effect.Effect<
    A,
    E,
    CfCredentialsModule.Credentials | HttpClient.HttpClient
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

const selectAccount = (accessToken: string) =>
  Effect.gen(function* () {
    const list = yield* cfAccounts.listAccounts;
    const response = yield* list({});
    const accounts = response.result;
    if (accounts.length === 0) {
      yield* new AuthError({
        message: "Cloudflare: no accounts found for this credential.",
      });
    }
    if (accounts.length === 1) {
      const account = accounts[0]!;
      yield* Clank.info(
        `Cloudflare: using account: ${account.name} (${account.id})`,
      );
      return account.id;
    }
    return yield* Clank.select({
      message: "Select a Cloudflare account",
      options: accounts.map((a) => ({
        value: a.id,
        label: a.name,
        hint: a.id,
      })),
    }).pipe(retryOnce);
  }).pipe((e) => withOAuthCredentials(accessToken, e));

const prettyPrint = (profileName: string, config: CloudflareAuthConfig) =>
  resolveCredentials(profileName, config).pipe(
    Effect.tap((creds) => {
      const sourceStr = creds.source.details
        ? `${creds.source.type} - ${creds.source.details}`
        : creds.source.type;
      return Match.value(creds).pipe(
        Match.when({ type: "apiToken" }, (c) =>
          Effect.all([
            Console.log(`  apiToken: ${displayRedacted(c.apiToken, 9)}`),
            Console.log(`  source: ${sourceStr}`),
          ]),
        ),
        Match.when({ type: "apiKey" }, (c) =>
          Effect.all([
            Console.log(`  apiKey: ${displayRedacted(c.apiKey)}`),
            Console.log(`  email:  ${displayRedacted(c.email)}`),
            Console.log(`  source: ${sourceStr}`),
          ]),
        ),
        Match.when({ type: "oauth" }, (c) => {
          const remainingMs = c.expires - Date.now();
          const expiresAt = new Date(c.expires).toISOString();
          const expiresStr =
            remainingMs <= 0
              ? `expired (${expiresAt})`
              : `in ${Duration.format(Duration.millis(remainingMs))} (${expiresAt})`;
          return Effect.all([
            Console.log(`  accessToken: ${displayRedacted(c.accessToken)}`),
            Console.log(`  expires: ${expiresStr}`),
            Console.log(`  source: ${sourceStr}`),
          ]);
        }),
        Match.exhaustive,
      );
    }),
    Effect.andThen(
      getEnv("CLOUDFLARE_ACCOUNT_ID").pipe(
        Effect.flatMap((envAccountId) => {
          const resolved = config.accountId ?? envAccountId;
          return Console.log(
            `  accountId: ${resolved ?? "(not set — configure or set CLOUDFLARE_ACCOUNT_ID)"}`,
          );
        }),
      ),
    ),
    Effect.catch((e) =>
      Console.error(`  Failed to retrieve credentials: ${e}`),
    ),
  );
