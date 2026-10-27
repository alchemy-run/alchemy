import * as NodeOs from "node:os";
import {
  AuthError,
  AuthProviderLayer,
  NeedsReauth,
  reconfigureHint,
  refreshHint,
  type ConfigureField,
  type ConfigureMethod,
  type ProviderDetails,
} from "alchemy/Auth/AuthProvider";
import { CredentialsStore, displayRedacted } from "alchemy/Auth/Credentials";
import { getEnv, getEnvRedacted, mapPromptCancellation } from "alchemy/Auth/Env";
import * as Interaction from "alchemy/Interaction";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  mintAccessToken,
  parseServiceAccountKey,
  refreshUserAccessToken,
  type ServiceAccountKey,
} from "./Token.ts";

export const GCP_AUTH_PROVIDER_NAME = "GCP";
export const GOOGLE_ACCESS_TOKEN_ENV = "GOOGLE_ACCESS_TOKEN";
export const GOOGLE_PROJECT_ID_ENV = "GOOGLE_PROJECT_ID";
export const GOOGLE_CLOUD_PROJECT_ENV = "GOOGLE_CLOUD_PROJECT";
export const GOOGLE_APPLICATION_CREDENTIALS_ENV = "GOOGLE_APPLICATION_CREDENTIALS";
/** Overrides gcloud's configuration directory (default `~/.config/gcloud`). */
export const CLOUDSDK_CONFIG_ENV = "CLOUDSDK_CONFIG";
/** Region when neither the environment nor the profile names one. */
export const DEFAULT_GCP_REGION = "us-central1";

/**
 * Default region for regional resources created without an explicit
 * location. Like the project, it is part of the profile.
 */
const region = Schema.optionalKey(Schema.String);

export const GcpAuthConfigSchema = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("gcloud"),
    /** Project to deploy into; defaults to the credential's quota project. */
    project: Schema.optionalKey(Schema.String),
    region,
  }),
  Schema.Struct({ method: Schema.Literal("env"), region }),
  Schema.Struct({
    method: Schema.Literal("serviceAccount"),
    credentialsFile: Schema.optionalKey(Schema.String),
    region,
  }),
  Schema.Struct({ method: Schema.Literal("stored"), region }),
]);
export type GcpAuthConfig = typeof GcpAuthConfigSchema.Type;

export const GcpStoredCredentialsSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("token"),
    accessToken: Schema.String,
    project: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("serviceAccount"),
    json: Schema.String,
    project: Schema.optionalKey(Schema.String),
  }),
]);
export type GcpStoredCredentials = typeof GcpStoredCredentialsSchema.Type;

export type GcpResolvedCredentials = {
  type: "token";
  accessToken: Redacted.Redacted<string>;
  project: string;
  /** Default region: env override, else the profile, else `us-central1`. */
  region: string;
  /** Epoch millis when a minted service-account token expires; absent for supplied tokens. */
  expiresAt?: number;
  source: { type: GcpAuthConfig["method"] | "env"; details?: string };
};

const options: Array<{
  value: GcpAuthConfig["method"];
  label: string;
  description?: string;
}> = [
  {
    value: "gcloud",
    label: "gcloud login",
    description: "your Google account, via gcloud auth application-default login",
  },
  {
    value: "env",
    label: "Environment Variables",
    description: `${GOOGLE_ACCESS_TOKEN_ENV} or ${GOOGLE_APPLICATION_CREDENTIALS_ENV} + ${GOOGLE_PROJECT_ID_ENV}`,
  },
  {
    value: "serviceAccount",
    label: "Service account JSON",
    description: "path to a service-account key file",
  },
  {
    value: "stored",
    label: "Stored",
    description: "token or key stored in ~/.alchemy/credentials",
  },
];

export const GcpAuth = AuthProviderLayer<GcpAuthConfig, GcpResolvedCredentials>()(
  GCP_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const store = yield* CredentialsStore;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const readKeyFile = (path: string): Effect.Effect<ServiceAccountKey, AuthError> =>
      fs.readFileString(path).pipe(
        Effect.flatMap(parseServiceAccountKey),
        Effect.mapError((e) =>
          AuthError.make({
            message: `Failed to read service-account key at ${path}`,
            cause: e,
          }),
        ),
      );

    // Minted tokens are cached by the `Credentials` layer until shortly
    // before `expiresAt` (see `lazyCredentials`), not here.
    const mint = (
      sa: ServiceAccountKey,
      project: string,
    ): Effect.Effect<Omit<GcpResolvedCredentials, "region">, AuthError> =>
      mintAccessToken(sa).pipe(
        Effect.map((minted) => ({
          type: "token" as const,
          accessToken: minted.accessToken,
          project,
          expiresAt: minted.expirationMs,
          source: {
            type: "serviceAccount" as const,
            details: sa.client_email,
          },
        })),
      );

    const resolveFromServiceAccount = (
      sa: ServiceAccountKey,
      explicitProject?: string,
    ): Effect.Effect<Omit<GcpResolvedCredentials, "region">, AuthError> => {
      const project = explicitProject ?? sa.project_id;
      if (!project) {
        return Effect.fail(
          AuthError.make({
            message: `Set ${GOOGLE_PROJECT_ID_ENV} (service-account JSON has no project_id)`,
          }),
        );
      }
      return mint(sa, project);
    };

    const adcPath = Effect.gen(function* () {
      const configDir = yield* getEnv(CLOUDSDK_CONFIG_ENV);
      if (configDir) return path.join(configDir, ADC_FILE);
      const platform = yield* Effect.sync(() => process.platform);
      const appData = platform === "win32" ? yield* getEnv("APPDATA") : undefined;
      if (appData) return path.join(appData, "gcloud", ADC_FILE);
      const home = yield* Effect.sync(() => NodeOs.homedir());
      return path.join(home, ".config", "gcloud", ADC_FILE);
    });

    /** The credential `gcloud auth application-default login` wrote, if any. */
    const readAdc = Effect.gen(function* () {
      const file = yield* adcPath;
      const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return undefined;
      const raw = yield* fs
        .readFileString(file)
        .pipe(
          Effect.mapError((cause) =>
            AuthError.make({ message: `Failed to read gcloud credentials at ${file}`, cause }),
          ),
        );
      const adc = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AdcFile))(raw).pipe(
        Effect.mapError((cause) =>
          AuthError.make({
            message: `Unsupported gcloud credentials at ${file}: expected a user login (authorized_user) or a service-account key.`,
            cause,
          }),
        ),
      );
      return { file, raw, adc };
    });

    const resolveFromGcloud = (
      profileName: string,
      config: Extract<GcpAuthConfig, { method: "gcloud" }>,
    ): Effect.Effect<Omit<GcpResolvedCredentials, "region">, AuthError | NeedsReauth> =>
      Effect.gen(function* () {
        const reauth = refreshHint(GCP_AUTH_PROVIDER_NAME, profileName);
        const found = yield* readAdc;
        if (found === undefined) {
          return yield* NeedsReauth.make({
            provider: GCP_AUTH_PROVIDER_NAME,
            profile: profileName,
            message: `GCP: no gcloud application-default login found. ${reauth}`,
          });
        }
        const { file, raw, adc } = found;
        if (adc.type === "service_account") {
          const sa = yield* parseServiceAccountKey(raw);
          return yield* resolveFromServiceAccount(sa, config.project);
        }
        const project = config.project ?? adc.quota_project_id;
        if (!project) {
          return yield* AuthError.make({
            message: `GCP: the gcloud login has no quota project. Set the profile's project. ${reconfigureHint(GCP_AUTH_PROVIDER_NAME, profileName)}`,
          });
        }
        const minted = yield* refreshUserAccessToken(adc).pipe(
          Effect.catchTag("GCP::InvalidGrant", (cause) =>
            Effect.fail(
              NeedsReauth.make({
                provider: GCP_AUTH_PROVIDER_NAME,
                profile: profileName,
                message: `GCP gcloud credentials need to be refreshed. ${reauth}`,
                cause,
              }),
            ),
          ),
        );
        return {
          type: "token" as const,
          accessToken: minted.accessToken,
          project,
          expiresAt: minted.expirationMs,
          source: { type: "gcloud" as const, details: file },
        };
      });

    const loginStored = Effect.fn(function* (profileName: string) {
      const kind = yield* Interaction.select({
        message: "GCP stored credential type",
        options: [
          {
            value: "token" as const,
            label: "Access token",
            description: "paste a bearer token from gcloud auth print-access-token",
          },
          {
            value: "serviceAccount" as const,
            label: "Service account JSON",
            description: "paste the key file contents",
          },
        ],
      }).pipe(mapPromptCancellation);

      const project = yield* Interaction.text({
        message: "GCP project id",
        validate: (v) => (v.length === 0 ? "Required" : undefined),
      }).pipe(mapPromptCancellation);

      if (kind === "token") {
        const accessToken = yield* Interaction.password({
          message: "Google access token",
          validate: (v) => (v.length === 0 ? "Required" : undefined),
        }).pipe(mapPromptCancellation);
        yield* store.write(profileName, GCP_AUTH_PROVIDER_NAME, GcpStoredCredentialsSchema, {
          type: "token",
          accessToken,
          project,
        });
      } else {
        const json = yield* Interaction.password({
          message: "Service account JSON",
          validate: (v) => (v.length === 0 ? "Required" : undefined),
        }).pipe(mapPromptCancellation);
        yield* parseServiceAccountKey(json);
        yield* store.write(profileName, GCP_AUTH_PROVIDER_NAME, GcpStoredCredentialsSchema, {
          type: "serviceAccount",
          json,
          project,
        });
      }
      yield* Interaction.success("GCP: credentials saved.");
      return { method: "stored" as const };
    });

    /** Sign in with gcloud, then ask which project to deploy into. */
    const configureGcloud = Effect.gen(function* () {
      yield* loginGcloud;
      const quotaProject = yield* readAdc.pipe(
        Effect.map((found) =>
          found?.adc.type === "authorized_user" ? found.adc.quota_project_id : undefined,
        ),
      );
      const project = yield* Interaction.text({
        message: "GCP project id",
        ...(quotaProject ? { placeholder: quotaProject, defaultValue: quotaProject } : {}),
        validate: (v) => (v.length === 0 && !quotaProject ? "Required" : undefined),
      }).pipe(mapPromptCancellation);
      const trimmed = (project ?? "").trim() || quotaProject;
      return { method: "gcloud" as const, ...(trimmed ? { project: trimmed } : {}) };
    });

    const configureInteractive = (profileName: string) =>
      Interaction.select({
        message: "GCP authentication method",
        options,
      }).pipe(
        mapPromptCancellation,
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("gcloud", () => configureGcloud),
            Match.when("env", () => Effect.succeed({ method: "env" as const })),
            Match.when("serviceAccount", () =>
              Interaction.text({
                message: "Path to service-account JSON (Enter for ADC env)",
                placeholder: `$${GOOGLE_APPLICATION_CREDENTIALS_ENV}`,
              }).pipe(
                mapPromptCancellation,
                Effect.map((path) => {
                  const trimmed = (path ?? "").trim();
                  return {
                    method: "serviceAccount" as const,
                    ...(trimmed.length > 0 ? { credentialsFile: trimmed } : {}),
                  };
                }),
              ),
            ),
            Match.when("stored", () => loginStored(profileName)),
            Match.exhaustive,
          ),
        ),
      );

    const promptRegion = Interaction.text({
      message: "Default GCP region",
      placeholder: DEFAULT_GCP_REGION,
    }).pipe(
      mapPromptCancellation,
      Effect.map((value) => (value ?? "").trim() || DEFAULT_GCP_REGION),
    );

    const configureCredentials = (_profileName: string) =>
      configureInteractive(_profileName).pipe(
        Effect.flatMap((config) =>
          promptRegion.pipe(Effect.map((region) => ({ ...config, region }))),
        ),
        Effect.mapError((e) =>
          AuthError.make({
            message: "failed to configure credentials",
            cause: e,
          }),
        ),
      );

    const regionField: ConfigureField = {
      name: "region",
      label: "Default GCP region",
      placeholder: DEFAULT_GCP_REGION,
      optional: true,
    };

    const serviceAccountFields: ReadonlyArray<ConfigureField> = [
      {
        name: "credentialsFile",
        label: "Path to service-account JSON",
        optional: true,
      },
      regionField,
    ];

    const gcloudFields: ReadonlyArray<ConfigureField> = [
      { name: "project", label: "GCP project id", optional: true },
      regionField,
    ];

    const configureMethods: ReadonlyArray<ConfigureMethod> = [
      { method: "gcloud", fields: gcloudFields },
      { method: "env", fields: [regionField] },
      { method: "serviceAccount", fields: serviceAccountFields },
    ];

    const regionOf = (values: Record<string, string>) => {
      const value = (values.region ?? "").trim();
      return value.length > 0 ? { region: value } : {};
    };

    const configureWith = (
      _profileName: string,
      input: {
        readonly method: string;
        readonly values: Record<string, string>;
      },
    ): Effect.Effect<GcpAuthConfig, AuthError> => {
      if (input.method === "gcloud") {
        // `gcloud auth application-default login` is interactive, so it is
        // NOT run here; the user runs `alchemy profile refresh` afterwards.
        const project = (input.values.project ?? "").trim();
        return Effect.succeed({
          method: "gcloud" as const,
          ...(project.length > 0 ? { project } : {}),
          ...regionOf(input.values),
        });
      }
      if (input.method === "env") {
        return Effect.succeed({
          method: "env" as const,
          ...regionOf(input.values),
        });
      }
      if (input.method === "serviceAccount") {
        const trimmed = (input.values.credentialsFile ?? "").trim();
        return Effect.succeed({
          method: "serviceAccount" as const,
          ...(trimmed.length > 0 ? { credentialsFile: trimmed } : {}),
          ...regionOf(input.values),
        });
      }
      return Effect.fail(
        AuthError.make({
          message: `GCP: unknown method '${input.method}'. Valid methods: gcloud, env, serviceAccount. (stored is interactive-only.)`,
        }),
      );
    };

    const resolveFromEnv = (): Effect.Effect<Omit<GcpResolvedCredentials, "region">, AuthError> =>
      Effect.gen(function* () {
        const project =
          (yield* getEnv(GOOGLE_PROJECT_ID_ENV)) ?? (yield* getEnv(GOOGLE_CLOUD_PROJECT_ENV));
        const token = yield* getEnvRedacted(GOOGLE_ACCESS_TOKEN_ENV);
        if (token) {
          if (!project) {
            return yield* AuthError.make({
              message: `GCP env credentials missing ${GOOGLE_PROJECT_ID_ENV}`,
            });
          }
          return {
            type: "token" as const,
            accessToken: token,
            project,
            source: { type: "env" as const, details: GOOGLE_ACCESS_TOKEN_ENV },
          };
        }
        const keyPath = yield* getEnv(GOOGLE_APPLICATION_CREDENTIALS_ENV);
        if (!keyPath) {
          return yield* AuthError.make({
            message: `GCP env credentials not found. Set ${GOOGLE_ACCESS_TOKEN_ENV}+${GOOGLE_PROJECT_ID_ENV} or ${GOOGLE_APPLICATION_CREDENTIALS_ENV}.`,
          });
        }
        const sa = yield* readKeyFile(keyPath);
        return yield* resolveFromServiceAccount(sa, project);
      });

    const resolveFromServiceAccountFile = (
      credentialsFile: string | undefined,
    ): Effect.Effect<Omit<GcpResolvedCredentials, "region">, AuthError> =>
      Effect.gen(function* () {
        const fromEnv = yield* getEnv(GOOGLE_APPLICATION_CREDENTIALS_ENV);
        const path = credentialsFile ?? fromEnv;
        if (!path) {
          return yield* AuthError.make({
            message: `GCP service-account key not found. Set ${GOOGLE_APPLICATION_CREDENTIALS_ENV}.`,
          });
        }
        const sa = yield* readKeyFile(path);
        const project =
          (yield* getEnv(GOOGLE_PROJECT_ID_ENV)) ?? (yield* getEnv(GOOGLE_CLOUD_PROJECT_ENV));
        return yield* resolveFromServiceAccount(sa, project);
      });

    const resolveFromStored = (
      profileName: string,
    ): Effect.Effect<Omit<GcpResolvedCredentials, "region">, AuthError | NeedsReauth> =>
      Effect.gen(function* () {
        const creds = yield* store.read(
          profileName,
          GCP_AUTH_PROVIDER_NAME,
          GcpStoredCredentialsSchema,
        );
        if (creds == null) {
          return yield* NeedsReauth.make({
            provider: GCP_AUTH_PROVIDER_NAME,
            profile: profileName,
            message: `GCP stored credentials not found. ${refreshHint(GCP_AUTH_PROVIDER_NAME, profileName)}`,
          });
        }
        if (creds.type === "token") {
          return {
            type: "token" as const,
            accessToken: Redacted.make(creds.accessToken),
            project: creds.project,
            source: { type: "stored" as const },
          };
        }
        const sa = yield* parseServiceAccountKey(creds.json);
        return yield* resolveFromServiceAccount(sa, creds.project);
      });

    const resolveToken = (
      profileName: string,
      config: GcpAuthConfig,
    ): Effect.Effect<Omit<GcpResolvedCredentials, "region">, AuthError | NeedsReauth> => {
      switch (config.method) {
        case "gcloud":
          return resolveFromGcloud(profileName, config);
        case "env":
          return resolveFromEnv();
        case "serviceAccount":
          return resolveFromServiceAccountFile(config.credentialsFile);
        case "stored":
          return resolveFromStored(profileName);
      }
    };

    // The region is part of the credential (the profile's `region`).
    // Google SDKs define no default-region environment variable; override
    // per stack with the `GCP.Region(...)` layer.
    const resolveCredentials = (
      profileName: string,
      config: GcpAuthConfig,
    ): Effect.Effect<GcpResolvedCredentials, AuthError | NeedsReauth> =>
      Effect.gen(function* () {
        const token = yield* resolveToken(profileName, config);
        return { ...token, region: config.region ?? DEFAULT_GCP_REGION };
      });

    const logout = (profileName: string, config: GcpAuthConfig) =>
      Match.value(config).pipe(
        // The login belongs to gcloud and other tools share it.
        Match.when({ method: "gcloud" }, () =>
          Interaction.info(
            "GCP: run `gcloud auth application-default revoke` to sign out of gcloud.",
          ),
        ),
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "serviceAccount" }, () => Effect.void),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, GCP_AUTH_PROVIDER_NAME)
            .pipe(Effect.andThen(Interaction.success("GCP: stored credentials removed"))),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: GcpAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "gcloud" }, (cfg) =>
          loginGcloud.pipe(Effect.andThen(resolveFromGcloud(profileName, cfg)), Effect.as(cfg)),
        ),
        Match.when({ method: "env" }, () => resolveFromEnv().pipe(Effect.as(config))),
        Match.when({ method: "serviceAccount" }, (cfg) =>
          resolveFromServiceAccountFile(cfg.credentialsFile).pipe(Effect.as(cfg)),
        ),
        Match.when({ method: "stored" }, () =>
          store
            .read(profileName, GCP_AUTH_PROVIDER_NAME, GcpStoredCredentialsSchema)
            .pipe(
              Effect.flatMap((creds) =>
                creds == null
                  ? loginStored(profileName).pipe(
                      Effect.map((stored) => ({ ...config, ...stored })),
                    )
                  : Effect.succeed(config),
              ),
            ),
        ),
        Match.exhaustive,
        Effect.mapError((e) => AuthError.make({ message: `login failed: ${e.message}`, cause: e })),
      );

    const details = (
      profileName: string,
      config: GcpAuthConfig,
    ): Effect.Effect<ProviderDetails, AuthError | NeedsReauth> =>
      resolveCredentials(profileName, config).pipe(
        Effect.map((creds) => {
          const sourceStr = creds.source.details
            ? `${creds.source.type} - ${creds.source.details}`
            : creds.source.type;
          return {
            lines: [
              { key: "project", value: creds.project },
              { key: "region", value: creds.region },
              {
                key: "accessToken",
                value: displayRedacted(creds.accessToken, 8),
              },
              { key: "source", value: sourceStr },
            ],
          };
        }),
      );

    const readEnvironment = resolveFromEnv().pipe(
      Effect.map((token) => ({ ...token, region: DEFAULT_GCP_REGION })),
    );

    return {
      configSchema: GcpAuthConfigSchema,
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
          name: GOOGLE_ACCESS_TOKEN_ENV,
          required: false,
          secret: true,
          description: "Bearer access token (alternative to a service-account key).",
        },
        {
          name: GOOGLE_APPLICATION_CREDENTIALS_ENV,
          required: false,
          description: "Path to a service-account JSON key.",
        },
        {
          name: GOOGLE_PROJECT_ID_ENV,
          required: false,
          alternatives: [GOOGLE_CLOUD_PROJECT_ENV],
          description: "GCP project id.",
        },
      ],
    };
  }),
);

const ADC_FILE = "application_default_credentials.json";

/** The credential types `gcloud auth application-default login` writes. */
const AdcFile = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("authorized_user"),
    client_id: Schema.String,
    client_secret: Schema.String,
    refresh_token: Schema.String,
    quota_project_id: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("service_account"),
    client_email: Schema.String,
    private_key: Schema.String,
  }),
]);

/** The authorization URL in gcloud's login prompt. */
export const parseGcloudLoginOutput = (output: string): string | undefined =>
  output.match(/https:\/\/accounts\.google\.com\/[^\s]+/)?.[0];

/**
 * `gcloud auth application-default login` waits on a localhost callback and
 * prints its authorization URL on stderr. `BROWSER=true` stops it opening a
 * tab of its own, so the URL goes through the same authorization screen as
 * the AWS logins.
 */
const loginGcloud = Effect.scoped(
  Effect.gen(function* () {
    const interaction = yield* Interaction.Interaction;
    const authorizationUrl = yield* Deferred.make<string>();
    const stderr = yield* Ref.make("");
    const handle = yield* ChildProcess.make("gcloud", ["auth", "application-default", "login"], {
      shell: false,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { BROWSER: "true" },
      extendEnv: true,
    }).pipe(
      Effect.mapError((cause) =>
        AuthError.make({
          message:
            "Failed to run gcloud. Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install",
          cause,
        }),
      ),
    );
    const collectStderr = handle.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          const combined = yield* Ref.updateAndGet(stderr, (current) => current + chunk);
          const url = parseGcloudLoginOutput(combined);
          if (url !== undefined) {
            yield* Deferred.succeed(authorizationUrl, url);
          }
        }),
      ),
    );
    const process = Effect.gen(function* () {
      const [exitCode] = yield* Effect.all(
        [handle.exitCode, Stream.runDrain(handle.stdout), collectStderr],
        { concurrency: 3 },
      );
      if (exitCode !== 0) {
        const detail = (yield* Ref.get(stderr)).trim();
        return yield* AuthError.make({
          message: `gcloud auth application-default login exited with code ${exitCode}${detail === "" ? "" : `: ${detail}`}`,
        });
      }
    });
    const processFiber = yield* Effect.forkScoped(process);
    const url = yield* Deferred.await(authorizationUrl).pipe(
      Effect.raceFirst(
        Fiber.join(processFiber).pipe(
          Effect.flatMap(() =>
            Effect.fail(
              AuthError.make({
                message: "gcloud login completed without providing an authorization URL.",
              }),
            ),
          ),
        ),
      ),
    );
    yield* Interaction.browserLogin({
      provider: "GCP",
      waitingLabel: "waiting for browser authorization…",
      url,
      waitFor: Fiber.join(processFiber),
    });
    yield* interaction.output.success("GCP: gcloud login complete");
  }),
);
