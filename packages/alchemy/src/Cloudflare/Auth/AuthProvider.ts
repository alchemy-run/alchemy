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
import { AuthError, type AuthProvider } from "../../Auth/AuthProvider.ts";
import {
  deleteCredentials,
  displayRedacted,
  readCredentials,
  writeCredentials,
} from "../../Auth/Credentials.ts";
import { getEnv, getEnvRedacted, retryOnce } from "../../Auth/Env.ts";
import * as Clank from "../../Util/Clank.ts";
import * as OAuthClient from "./OAuthClient.ts";

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

export const ALL_SCOPES = {
  "access:read":
    "See Cloudflare Access data such as zones, applications, certificates, device postures, groups, identity providers, login counts, organizations, policies, service tokens, and users",
  "access:write":
    "See and change Cloudflare Access data such as zones, applications, certificates, device postures, groups, identity providers, login counts, organizations, policies, service tokens, and users",
  "account:read":
    "See your account info such as account details, analytics, and memberships",
  "agw:read": "Grants read level access to Agents Gateway",
  "agw:run": "Grants run level access to Agents Gateway",
  "agw:write": "Grants read and write level access to Agents Gateway",
  "ai:read": "Grants read level access to Workers AI",
  "ai:write": "Grants write level access to Workers AI",
  "aiaudit:read": "Grants read level access to AI Audit",
  "aiaudit:write": "Grants write level access to AI Audit",
  "aig:read": "Grants read level access to AI Gateway",
  "aig:write": "Grants write level access to AI Gateway",
  "auditlogs:read": "View Cloudflare Account Audit Logs",
  "browser:read": "Grants read level access to Browser Rendering",
  "browser:write": "Grants write level access to Browser Rendering",
  "cfone:read": "Grants read level access to Cloudforce One data",
  "cfone:write": "Grants write level access to Cloudforce One data",
  "cloudchamber:write": "See and make changes to Cloudchamber",
  "connectivity:admin":
    "See, change, and bind to Connectivity Directory services, including creating services targeting Cloudflare Tunnel",
  "connectivity:bind":
    "read, list, and bind to Connectivity Directory services, as well as read and list Cloudflare Tunnels",
  "connectivity:read":
    "See Connectivity Directory services and Cloudflare Tunnels",
  "constellation:write":
    "Grants write access to Constellation configuration and models",
  "containers:write": "See and make changes to Workers Containers",
  "d1:write": "See and make changes to D1",
  "dex:read": "Grants read level access to Cloudflare DEX",
  "dex:write": "Grants write level access to Cloudflare DEX",
  "dns_analytics:read": "Grants read level access to Cloudflare DNS Analytics",
  "dns_records:edit": "Grants edit level access to dns records",
  "dns_records:read": "Grants read level access to dns records",
  "dns_settings:read": "Grants read level access to Cloudflare DNS Settings",
  "firstpartytags:write":
    "Can see, edit and publish Google tag gateway configuration.",
  "lb:edit": "Grants edit level access to lb and lb pools",
  "lb:read": "Grants read level access to lb and lb pools",
  "logpush:read": "See Cloudflare Logpush data",
  "logpush:write": "See and change Cloudflare Logpush data",
  "notification:read": "View Cloudflare Notifications",
  "notification:write": "View and Modify Cloudflare Notifications",
  "pages:read": "See Cloudflare Pages projects, settings and deployments",
  "pages:write":
    "See and change Cloudflare Pages projects, settings and deployments",
  "pipelines:read": "Grants read level access to Cloudflare Pipelines",
  "pipelines:setup":
    "Grants permission to generate R2 tokens for Workers Pipelines",
  "pipelines:write": "Grants write level access to Cloudflare Pipelines",
  "query_cache:write": "See and make changes to Hyperdrive",
  "queues:write": "See and change Cloudflare Queues settings and data",
  "r2_catalog:write": "Grants write level access to R2 Data Catalog",
  "radar:read": "Grants access to read Cloudflare Radar data",
  "ai-search:read": "Grants read level access to AI Search",
  "ai-search:write": "Grants write level access to AI Search",
  "ai-search:run": "Grants run level access to AI Search",
  "secrets_store:read": "Grants read level access to Secrets Store",
  "secrets_store:write": "Grants write level access to Secrets Store",
  "ssl_certs:write":
    "Grants read and write access to SSL MTLS certificates or Certificate Store",
  "sso-connector:read": "See Cloudflare SSO connectors",
  "sso-connector:write":
    "See Cloudflare SSO connectors to toggle activation and deactivation of SSO",
  "teams:pii": "See personally identifiable Cloudflare Teams data",
  "teams:read":
    "See Cloudflare Teams data such as zones, gateway, and argo tunnel details",
  "teams:secure_location":
    "See all DNS Location data but can only change secure DNS Locations",
  "teams:write":
    "See and change Cloudflare Teams data such as zones, gateway, and argo tunnel details",
  "url_scanner:read": "Grants read level access to URL Scanner",
  "url_scanner:write": "Grants write level access to URL Scanner",
  "user:read":
    "See your user info such as name, email address, and account memberships",
  "vectorize:write": "See and make changes to Vectorize",
  "workers:read":
    "See Cloudflare Workers data such as zones, KV storage, R2 storage, scripts, and routes",
  "workers:write":
    "See and change Cloudflare Workers data such as zones, KV storage, R2 storage, scripts, and routes",
  "workers_builds:read":
    "See Cloudflare Workers Builds data such as builds, build configuration, and build logs",
  "workers_builds:write":
    "See and change Cloudflare Workers Builds data such as builds, build configuration, and build logs",
  "workers_kv:write":
    "See and change Cloudflare Workers KV Storage data such as keys and namespaces",
  "workers_observability:read":
    "Grants read access to Cloudflare Workers Observability",
  "workers_observability_telemetry:write":
    "Grants write access to Cloudflare Workers Observability Telemetry API",
  "workers_routes:write":
    "See and change Cloudflare Workers data such as filters and routes",
  "workers_scripts:write":
    "See and change Cloudflare Workers scripts, durable objects, subdomains, triggers, and tail data",
  "workers_tail:read": "See Cloudflare Workers tail and script data",
  "zone:read": "Grants read level access to account zone",
};

export const DEFAULT_SCOPES = [
  "account:read",
  "ai-search:write",
  "ai-search:run",
  "ai:write",
  "cloudchamber:write",
  "connectivity:admin",
  "containers:write",
  "d1:write",
  "pages:write",
  "pipelines:write",
  "queues:write",
  "secrets_store:write",
  "ssl_certs:write",
  "user:read",
  "vectorize:write",
  "workers_kv:write",
  "workers_routes:write",
  "workers_scripts:write",
  "workers_tail:read",
  "workers:write",
  "zone:read",
];

export const OAUTH_CLIENT_ID = "6d8c2255-0773-45f6-b376-2914632e6f91";
export const OAUTH_REDIRECT_URI = "http://localhost:9976/auth/callback";
export const OAUTH_ENDPOINTS = {
  authorize: "https://dash.cloudflare.com/oauth2/authorize",
  token: "https://dash.cloudflare.com/oauth2/token",
  revoke: "https://dash.cloudflare.com/oauth2/revoke",
};
