import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureContext,
} from "../Auth/AuthProvider.ts";
import { CredentialsStore, displayRedacted } from "../Auth/Credentials.ts";
import { getEnv, getEnvRedacted, retryOnce } from "../Auth/Env.ts";
import { AlchemyProfile } from "../Auth/Profile.ts";
import * as Clank from "../Util/Clank.ts";
import {
  mintAccessToken,
  parseServiceAccountKey,
  type ServiceAccountKey,
} from "./Token.ts";

export const GCP_AUTH_PROVIDER_NAME = "GCP";
export const GOOGLE_ACCESS_TOKEN_ENV = "GOOGLE_ACCESS_TOKEN";
export const GOOGLE_PROJECT_ID_ENV = "GOOGLE_PROJECT_ID";
export const GOOGLE_APPLICATION_CREDENTIALS_ENV =
  "GOOGLE_APPLICATION_CREDENTIALS";

const STORAGE_KEY = "gcp-stored";

export type GcpAuthConfig =
  | { method: "env" }
  | { method: "stored" }
  | { method: "serviceAccount"; credentialsFile?: string };

export type GcpStoredCredentials =
  | { type: "token"; accessToken: string; project: string }
  | { type: "serviceAccount"; json: string; project?: string };

export type GcpResolvedCredentials = {
  type: "token";
  accessToken: Redacted.Redacted<string>;
  project: string;
  source: { type: GcpAuthConfig["method"]; details?: string };
};

const options: Array<{
  value: GcpAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
  {
    value: "env",
    label: "Environment Variables",
    hint: `${GOOGLE_ACCESS_TOKEN_ENV} or ${GOOGLE_APPLICATION_CREDENTIALS_ENV} + ${GOOGLE_PROJECT_ID_ENV}`,
  },
  {
    value: "serviceAccount",
    label: "Service account JSON",
    hint: "path to a service-account key file",
  },
  {
    value: "stored",
    label: "Stored",
    hint: "token or key stored in ~/.alchemy/credentials",
  },
];

const REFRESH_WINDOW_MS = 5 * 60 * 1000;

export const GcpAuth = AuthProviderLayer<
  GcpAuthConfig,
  GcpResolvedCredentials
>()(
  GCP_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const profiles = yield* AlchemyProfile;
    const store = yield* CredentialsStore;
    const fs = yield* FileSystem.FileSystem;
    const tokenCache = yield* Ref.make<
      { accessToken: string; expirationMs: number; project: string } | undefined
    >(undefined);

    const readKeyFile = (path: string) =>
      fs.readFileString(path).pipe(
        Effect.flatMap(parseServiceAccountKey),
        Effect.mapError(
          (e) =>
            new AuthError({
              message: `Failed to read service-account key at ${path}`,
              cause: e,
            }),
        ),
      );

    const mintCached = (
      sa: ServiceAccountKey,
      project: string,
    ): Effect.Effect<GcpResolvedCredentials, AuthError> =>
      Effect.gen(function* () {
        const now = yield* Effect.sync(() => Date.now());
        const cached = yield* Ref.get(tokenCache);
        if (
          cached &&
          cached.project === project &&
          cached.expirationMs - now > REFRESH_WINDOW_MS
        ) {
          const resolved: GcpResolvedCredentials = {
            type: "token",
            accessToken: Redacted.make(cached.accessToken),
            project,
            source: {
              type: "serviceAccount",
              details: sa.client_email,
            },
          };
          return resolved;
        }
        const minted = yield* mintAccessToken(sa);
        yield* Ref.set(tokenCache, {
          accessToken: Redacted.value(minted.accessToken),
          expirationMs: minted.expirationMs,
          project,
        });
        const resolved: GcpResolvedCredentials = {
          type: "token",
          accessToken: minted.accessToken,
          project,
          source: {
            type: "serviceAccount",
            details: sa.client_email,
          },
        };
        return resolved;
      });

    const resolveFromServiceAccount = (
      sa: ServiceAccountKey,
      explicitProject?: string,
    ): Effect.Effect<GcpResolvedCredentials, AuthError> => {
      const project = explicitProject ?? sa.project_id;
      if (!project) {
        return Effect.fail(
          new AuthError({
            message: `Set ${GOOGLE_PROJECT_ID_ENV} (service-account JSON has no project_id)`,
          }),
        );
      }
      return mintCached(sa, project);
    };

    const loginStored = Effect.fn(function* (profileName: string) {
      const kind = yield* Clank.select({
        message: "GCP stored credential type",
        options: [
          {
            value: "token" as const,
            label: "Access token",
            hint: "paste a bearer token from gcloud auth print-access-token",
          },
          {
            value: "serviceAccount" as const,
            label: "Service account JSON",
            hint: "paste the key file contents",
          },
        ],
      }).pipe(retryOnce);

      const project = yield* Clank.text({
        message: "GCP project id",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);

      if (kind === "token") {
        const accessToken = yield* Clank.password({
          message: "Google access token",
          validate: (v) => (v.length === 0 ? "Required" : undefined),
        }).pipe(retryOnce);
        yield* store.write<GcpStoredCredentials>(profileName, STORAGE_KEY, {
          type: "token",
          accessToken,
          project,
        });
      } else {
        const json = yield* Clank.password({
          message: "Service account JSON",
          validate: (v) => (v.length === 0 ? "Required" : undefined),
        }).pipe(retryOnce);
        yield* parseServiceAccountKey(json);
        yield* store.write<GcpStoredCredentials>(profileName, STORAGE_KEY, {
          type: "serviceAccount",
          json,
          project,
        });
      }
      yield* Clank.success("GCP: credentials saved.");
      return { method: "stored" as const };
    });

    const configureInteractive = (profileName: string) =>
      Clank.select({
        message: "GCP authentication method",
        options,
      }).pipe(
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("env", () => Effect.succeed({ method: "env" as const })),
            Match.when("serviceAccount", () =>
              Clank.text({
                message: "Path to service-account JSON (Enter for ADC env)",
                placeholder: `$${GOOGLE_APPLICATION_CREDENTIALS_ENV}`,
              }).pipe(
                retryOnce,
                Effect.map((path) => {
                  const trimmed = (path ?? "").trim();
                  return {
                    method: "serviceAccount" as const,
                    credentialsFile: trimmed.length > 0 ? trimmed : undefined,
                  };
                }),
              ),
            ),
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

    const resolveFromEnv = (): Effect.Effect<
      GcpResolvedCredentials,
      AuthError
    > =>
      Effect.gen(function* () {
        const project = yield* getEnv(GOOGLE_PROJECT_ID_ENV);
        const token = yield* getEnvRedacted(GOOGLE_ACCESS_TOKEN_ENV);
        if (token) {
          if (!project) {
            return yield* new AuthError({
              message: `GCP env credentials missing ${GOOGLE_PROJECT_ID_ENV}`,
            });
          }
          const resolved: GcpResolvedCredentials = {
            type: "token",
            accessToken: token,
            project,
            source: { type: "env", details: GOOGLE_ACCESS_TOKEN_ENV },
          };
          return resolved;
        }
        const keyPath = yield* getEnv(GOOGLE_APPLICATION_CREDENTIALS_ENV);
        if (!keyPath) {
          return yield* new AuthError({
            message: `GCP env credentials not found. Set ${GOOGLE_ACCESS_TOKEN_ENV}+${GOOGLE_PROJECT_ID_ENV} or ${GOOGLE_APPLICATION_CREDENTIALS_ENV}.`,
          });
        }
        const sa = yield* readKeyFile(keyPath);
        return yield* resolveFromServiceAccount(sa, project);
      });

    const resolveFromServiceAccountFile = (
      credentialsFile: string | undefined,
    ): Effect.Effect<GcpResolvedCredentials, AuthError> =>
      Effect.gen(function* () {
        const fromEnv = yield* getEnv(GOOGLE_APPLICATION_CREDENTIALS_ENV);
        const path = credentialsFile ?? fromEnv;
        if (!path) {
          return yield* new AuthError({
            message: `GCP service-account key not found. Set ${GOOGLE_APPLICATION_CREDENTIALS_ENV}.`,
          });
        }
        const sa = yield* readKeyFile(path);
        const project = yield* getEnv(GOOGLE_PROJECT_ID_ENV);
        return yield* resolveFromServiceAccount(sa, project);
      });

    const resolveFromStored = (
      profileName: string,
    ): Effect.Effect<GcpResolvedCredentials, AuthError> =>
      store.read<GcpStoredCredentials>(profileName, STORAGE_KEY).pipe(
        Effect.flatMap(
          (creds): Effect.Effect<GcpResolvedCredentials, AuthError> => {
            if (creds == null) {
              return Effect.fail(
                new AuthError({
                  message:
                    "GCP stored credentials not found. Run: alchemy login --configure",
                }),
              );
            }
            if (creds.type === "token") {
              return Effect.succeed({
                type: "token",
                accessToken: Redacted.make(creds.accessToken),
                project: creds.project,
                source: { type: "stored" },
              });
            }
            return parseServiceAccountKey(creds.json).pipe(
              Effect.flatMap((sa) =>
                resolveFromServiceAccount(sa, creds.project),
              ),
            );
          },
        ),
      );

    const resolveCredentials = (
      profileName: string,
      config: GcpAuthConfig,
    ): Effect.Effect<GcpResolvedCredentials, AuthError> => {
      switch (config.method) {
        case "env":
          return resolveFromEnv();
        case "serviceAccount":
          return resolveFromServiceAccountFile(config.credentialsFile);
        case "stored":
          return resolveFromStored(profileName);
      }
    };

    const logout = (profileName: string, config: GcpAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "serviceAccount" }, () => Effect.void),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, STORAGE_KEY)
            .pipe(
              Effect.andThen(Clank.success("GCP: stored credentials removed")),
            ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: GcpAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "env" }, () =>
            getEnvRedacted(GOOGLE_ACCESS_TOKEN_ENV).pipe(
              Effect.flatMap((token) =>
                token
                  ? Effect.void
                  : getEnv(GOOGLE_APPLICATION_CREDENTIALS_ENV).pipe(
                      Effect.flatMap((path) =>
                        path
                          ? Effect.void
                          : Effect.gen(function* () {
                              const next =
                                yield* configureInteractive(profileName);
                              const existing =
                                yield* profiles.getProfile(profileName);
                              yield* profiles.setProfile(profileName, {
                                ...existing,
                                [GCP_AUTH_PROVIDER_NAME]: next,
                              });
                            }),
                      ),
                    ),
              ),
            ),
          ),
          Match.when({ method: "serviceAccount" }, (cfg) =>
            Effect.gen(function* () {
              const path =
                cfg.credentialsFile ??
                (yield* getEnv(GOOGLE_APPLICATION_CREDENTIALS_ENV));
              if (!path) {
                return yield* configureInteractive(profileName).pipe(
                  Effect.flatMap((next) =>
                    profiles.getProfile(profileName).pipe(
                      Effect.flatMap((existing) =>
                        profiles.setProfile(profileName, {
                          ...existing,
                          [GCP_AUTH_PROVIDER_NAME]: next,
                        }),
                      ),
                    ),
                  ),
                );
              }
            }),
          ),
          Match.when({ method: "stored" }, () =>
            store
              .read<GcpStoredCredentials>(profileName, STORAGE_KEY)
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

    const prettyPrint = (profileName: string, config: GcpAuthConfig) =>
      resolveCredentials(profileName, config).pipe(
        Effect.tap((creds) => {
          const sourceStr = creds.source.details
            ? `${creds.source.type} - ${creds.source.details}`
            : creds.source.type;
          return Effect.all([
            Console.log(`  project: ${creds.project}`),
            Console.log(
              `  accessToken: ${displayRedacted(creds.accessToken, 8)}`,
            ),
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
