import * as DistilledAuth from "@distilled.cloud/aws/Auth";
import {
  Credentials,
  ExpiredSSOToken,
  InvalidSSOToken,
} from "@distilled.cloud/aws/Credentials";
import type { CredentialsError } from "@distilled.cloud/aws/Credentials";
import * as STS from "@distilled.cloud/aws/sts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as NodeCrypto from "node:crypto";
import * as NodeOs from "node:os";
import {
  AuthError,
  AuthProviderLayer,
  needsReauth,
  refreshHint,
  type ConfigureField,
  type ConfigureMethod,
  type ProviderDetailLine,
} from "../Auth/AuthProvider.ts";
import { CredentialsStore, displayRedacted } from "../Auth/Credentials.ts";
import {
  getEnv,
  getEnvRedacted,
  getEnvRedactedRequired,
  getEnvRequired,
  mapPromptCancellation,
} from "../Auth/Env.ts";
import { validateFieldValues } from "../Auth/StoredAuthProvider.ts";
import * as CliKit from "../Cli/CliKit/index.ts";
import * as Region from "./Region.ts";

export const AWS_AUTH_PROVIDER_NAME = "AWS";

export type AwsAuthConfig =
  | { method: "sso"; ssoProfile: string }
  | { method: "stored" };

/** Manifest-entry schema for {@link AwsAuthConfig}. */
export const AwsAuthConfigSchema: Schema.Codec<AwsAuthConfig, any> =
  Schema.Union([
    Schema.Struct({
      method: Schema.Literal("sso"),
      ssoProfile: Schema.String,
    }),
    Schema.Struct({ method: Schema.Literal("stored") }),
  ]);

const options: Array<{
  value: AwsAuthConfig["method"];
  label: string;
  description?: string;
}> = [
  {
    value: "sso",
    label: "SSO",
    description: "sign in with an AWS IAM Identity Center profile",
  },
  {
    value: "stored",
    label: "Access Keys",
    description: "enter an access key and secret directly",
  },
];

export const AwsStoredCredentials = Schema.Struct({
  accountId: Schema.String,
  accessKeyId: Schema.String,
  secretAccessKey: Schema.String,
  sessionToken: Schema.optional(Schema.String),
  region: Schema.String,
});
export type AwsStoredCredentials = typeof AwsStoredCredentials.Type;

const STORAGE_KEY = "aws-stored";

/** `--set` fields for `--method keys` (static access keys, persisted). */
const keysFields: ReadonlyArray<ConfigureField> = [
  { name: "accessKeyId", label: "AWS Access Key ID" },
  { name: "secretAccessKey", label: "AWS Secret Access Key", secret: true },
  {
    name: "sessionToken",
    label: "AWS Session Token",
    secret: true,
    optional: true,
  },
  { name: "region", label: "AWS Region", placeholder: "us-east-1" },
];

/** `--set` fields for `--method sso` (nothing persisted; profile validated). */
const ssoFields: ReadonlyArray<ConfigureField> = [
  { name: "ssoProfile", label: "AWS profile name (from ~/.aws/config)" },
];

const configureMethods: ReadonlyArray<ConfigureMethod> = [
  { method: "keys", fields: keysFields },
  { method: "sso", fields: ssoFields },
];

export interface AwsResolvedCredentials {
  accountId: string;
  credentials: Effect.Effect<
    {
      accessKeyId: Redacted.Redacted<string>;
      secretAccessKey: Redacted.Redacted<string>;
      sessionToken: Redacted.Redacted<string> | undefined;
      region: string;
    },
    CredentialsError
  >;
  region: string;
  source: {
    type: AwsAuthConfig["method"] | "env";
    details?: string;
  };
}

/**
 * An explicitly-set `AWS_REGION` env var wins over the region recorded in an
 * SSO profile (`~/.aws/config`) or in stored credentials. `AWS_DEFAULT_REGION`
 * deliberately does NOT override — it is a *default* for when no region is
 * configured anywhere, and the profile's region is explicit configuration.
 */
export const applyEnvRegionOverride = <C extends { region: string }>(
  creds: C,
): Effect.Effect<C, AuthError> =>
  getEnv("AWS_REGION").pipe(
    Effect.map((envRegion) =>
      envRegion ? { ...creds, region: envRegion } : creds,
    ),
  );

/**
 * Layer that registers the AWS {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Include this in the AWS
 * `providers()` layer so the alchemy CLI can discover it.
 */
export const AwsAuth = AuthProviderLayer<
  AwsAuthConfig,
  AwsResolvedCredentials
>()(
  AWS_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const prompt = yield* CliKit.CliKit;
    const store = yield* CredentialsStore;

    const getAccountId = ({
      accessKeyId,
      secretAccessKey,
      sessionToken,
      region,
    }: {
      accessKeyId: Redacted.Redacted<string>;
      secretAccessKey: Redacted.Redacted<string>;
      sessionToken?: Redacted.Redacted<string>;
      region: string;
    }) =>
      STS.getCallerIdentity({}).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(
              Credentials,
              Effect.succeed({
                accessKeyId,
                secretAccessKey,
                sessionToken,
                region,
              }),
            ),
            // Provide Region directly from the resolved inputs. Relying on the
            // ambient Region provider (Region.fromEnvironment) here would
            // deadlock: it derives the region from AWSEnvironment, which is the
            // very service still being constructed by this STS call.
            Region.of(region),
          ),
        ),
        Effect.flatMap((self) =>
          self.Account
            ? Effect.succeed(self.Account)
            : Effect.die(new Error("No account ID found")),
        ),
      );

    const loginStored = Effect.fn(function* (profileName: string) {
      const accessKeyId = yield* prompt.prompt
        .text({
          message: "AWS Access Key ID",
          validate: (v) => (v.length === 0 ? "Required" : undefined),
        })
        .pipe(mapPromptCancellation);

      const secretAccessKey = yield* prompt.prompt
        .password({
          message: "AWS Secret Access Key",
          validate: (v) => (v.length === 0 ? "Required" : undefined),
        })
        .pipe(mapPromptCancellation);

      const sessionToken = yield* prompt.prompt
        .password({
          message: "AWS Session Token (optional; press Enter to skip)",
          placeholder: "(none)",
        })
        .pipe(mapPromptCancellation);

      const region = yield* prompt.prompt
        .text({
          message: "AWS Region",
          placeholder: "us-east-1",
          defaultValue: "us-east-1",
        })
        .pipe(mapPromptCancellation);

      const accountId = yield* getAccountId({
        accessKeyId: Redacted.make(accessKeyId),
        secretAccessKey: Redacted.make(secretAccessKey),
        sessionToken: sessionToken ? Redacted.make(sessionToken) : undefined,
        region,
      });

      yield* store.write(profileName, STORAGE_KEY, AwsStoredCredentials, {
        accountId,
        accessKeyId,
        secretAccessKey,
        sessionToken,
        region,
      });
      yield* prompt.output.success("AWS credentials saved.");

      return { method: "stored" as const };
    });

    const configureInteractive = (profileName: string) =>
      prompt.prompt
        .select({
          message: "AWS authentication method",
          options,
        })
        .pipe(
          Effect.flatMap((method) =>
            Match.value(method).pipe(
              Match.when("sso", () =>
                Effect.gen(function* () {
                  const ssoProfile = yield* prompt.prompt.text({
                    message: "AWS profile name (from ~/.aws/config)",
                    placeholder: "default",
                    defaultValue: "default",
                  });

                  const config = {
                    method: "sso" as const,
                    ssoProfile: ssoProfile ?? "default",
                  };

                  yield* loginSSO(config);

                  return config;
                }),
              ),
              Match.when("stored", () => loginStored(profileName)),
              Match.exhaustive,
            ),
          ),
        );

    // The declared requirements are the union of the interactive path
    // (ChildProcessSpawner for `aws sso login`) and `configureWith`'s
    // (FileSystem/Path for ~/.aws/config probing) — the contract shares one
    // ConfigureReq type parameter between the two entry points.
    const configureCredentials = (
      profileName: string,
    ): Effect.Effect<
      AwsAuthConfig,
      AuthError,
      | ChildProcessSpawner
      | HttpClient.HttpClient
      | FileSystem.FileSystem
      | Path.Path
    > =>
      configureInteractive(profileName).pipe(
        Effect.mapError(
          (e) =>
            new AuthError({
              message: "failed to configure credentials",
              cause: e,
            }),
        ),
      );

    const configureWith = (
      profileName: string,
      input: {
        readonly method: string;
        readonly values: Record<string, string>;
      },
    ) =>
      Match.value(input.method).pipe(
        Match.when("keys", () =>
          Effect.gen(function* () {
            const values = yield* validateFieldValues(
              AWS_AUTH_PROVIDER_NAME,
              keysFields,
              input.values,
            );
            // validateFieldValues guarantees the required fields are present.
            const accessKeyId = values.accessKeyId!;
            const secretAccessKey = values.secretAccessKey!;
            const sessionToken = values.sessionToken;
            const region = values.region!;
            const accountId = yield* getAccountId({
              accessKeyId: Redacted.make(accessKeyId),
              secretAccessKey: Redacted.make(secretAccessKey),
              sessionToken: sessionToken
                ? Redacted.make(sessionToken)
                : undefined,
              region,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new AuthError({
                    message:
                      "AWS: failed to verify credentials via STS GetCallerIdentity.",
                    cause,
                  }),
              ),
            );
            yield* store.write(profileName, STORAGE_KEY, AwsStoredCredentials, {
              accountId,
              accessKeyId,
              secretAccessKey,
              sessionToken,
              region,
            });
            return { method: "stored" as const };
          }),
        ),
        Match.when("sso", () =>
          Effect.gen(function* () {
            const values = yield* validateFieldValues(
              AWS_AUTH_PROVIDER_NAME,
              ssoFields,
              input.values,
            );
            const ssoProfile = values.ssoProfile!;
            const auth = yield* DistilledAuth.Default;
            const profile = yield* auth
              .loadProfile(ssoProfile)
              .pipe(Effect.catch(() => Effect.succeed(undefined)));
            if (profile == null) {
              return yield* Effect.fail(
                new AuthError({
                  message: `AWS SSO profile '${ssoProfile}' was not found in ~/.aws/config. Configure it with \`aws configure sso\` first, then run \`alchemy profile refresh\` to log in.`,
                }),
              );
            }
            // Nothing is persisted for SSO — credentials come from the AWS
            // SSO cache. `aws sso login` is interactive, so it is NOT run
            // here; the user runs `alchemy profile refresh` afterwards.
            return { method: "sso" as const, ssoProfile };
          }),
        ),
        Match.orElse(() =>
          Effect.fail(
            new AuthError({
              message: `AWS: unknown method '${input.method}'. Supported methods: keys, sso.`,
            }),
          ),
        ),
      );

    const resolveCredentials = (profileName: string, config: AwsAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "stored" }, () =>
            store.read(profileName, STORAGE_KEY, AwsStoredCredentials).pipe(
              Effect.flatMap((creds) =>
                creds == null
                  ? Effect.fail(
                      needsReauth({
                        provider: AWS_AUTH_PROVIDER_NAME,
                        profile: profileName,
                        detail: "AWS stored credentials not found.",
                      }),
                    )
                  : Effect.succeed({
                      accountId: creds.accountId,
                      credentials: Effect.succeed({
                        accessKeyId: Redacted.make(creds.accessKeyId),
                        secretAccessKey: Redacted.make(creds.secretAccessKey),
                        sessionToken: creds.sessionToken
                          ? Redacted.make(creds.sessionToken)
                          : undefined,
                        region: creds.region,
                      }),
                      region: creds.region,
                      source: { type: "stored" as const },
                    } satisfies AwsResolvedCredentials),
              ),
              // an older verson of the stored credentials didn't include the account ID, so we patch it hre
              Effect.flatMap((creds) =>
                creds.accountId
                  ? Effect.succeed(creds)
                  : creds.credentials.pipe(
                      Effect.flatMap((resolved) =>
                        getAccountId({
                          accessKeyId: resolved.accessKeyId,
                          secretAccessKey: resolved.secretAccessKey,
                          sessionToken: resolved.sessionToken,
                          region: creds.region,
                        }),
                      ),
                      Effect.map(
                        (accountId) =>
                          ({
                            ...creds,
                            accountId,
                          }) satisfies AwsResolvedCredentials,
                      ),
                      // re-write the stored credentials
                      Effect.tap((creds) =>
                        creds.credentials.pipe(
                          Effect.tap(
                            ({ accessKeyId, secretAccessKey, sessionToken }) =>
                              store.write(
                                profileName,
                                STORAGE_KEY,
                                AwsStoredCredentials,
                                {
                                  accessKeyId: Redacted.value(accessKeyId),
                                  secretAccessKey:
                                    Redacted.value(secretAccessKey),
                                  sessionToken: sessionToken
                                    ? Redacted.value(sessionToken)
                                    : undefined,
                                  region: creds.region,
                                  accountId: creds.accountId,
                                },
                              ),
                          ),
                        ),
                      ),
                    ),
              ),
            ),
          ),
          Match.when({ method: "sso" }, (config) =>
            Effect.gen(function* () {
              const auth = yield* DistilledAuth.Default;
              const profile = yield* auth
                .loadProfile(config.ssoProfile)
                .pipe(Effect.catch(() => Effect.succeed(undefined)));
              if (profile?.sso_account_id == null) {
                return yield* Effect.fail(
                  new AuthError({
                    message:
                      profile == null
                        ? `AWS SSO profile '${config.ssoProfile}' was not found in ~/.aws/config. Configure it with \`aws configure sso\`, or run \`alchemy profile edit --reconfigure AWS\`.`
                        : `AWS SSO profile '${config.ssoProfile}' has no sso_account_id in ~/.aws/config. Add it, or run \`alchemy profile edit --reconfigure AWS\`.`,
                  }),
                );
              }
              // `applyEnvRegionOverride` below only overrides an existing
              // region, so an env-provided region must be consulted here for
              // profiles that don't record one.
              const region = profile.region ?? (yield* getEnv("AWS_REGION"));
              if (!region) {
                return yield* Effect.fail(
                  new AuthError({
                    message: `AWS SSO profile '${config.ssoProfile}' has no region in ~/.aws/config and AWS_REGION is not set.`,
                  }),
                );
              }
              return {
                accountId: profile.sso_account_id,
                // Rewrite the message of an expired/invalid SSO token to the
                // alchemy refresh hint, but PRESERVE the error tags: the inner
                // effect must stay a `CredentialsError` for downstream
                // consumers (AWSEnvironment), while `details` and other
                // in-provider consumers match these tags to surface a typed
                // `NeedsReauth` instead of a generic failure.
                credentials: auth
                  .loadProfileCredentials(config.ssoProfile)
                  .pipe(
                    Effect.mapError((error) => {
                      if (error._tag === "Alchemy::AWS::ExpiredSSOToken") {
                        return new ExpiredSSOToken({
                          message: `AWS SSO credentials need to be refreshed. ${refreshHint(AWS_AUTH_PROVIDER_NAME, profileName)}`,
                          profile: error.profile,
                        });
                      }
                      if (error._tag === "Alchemy::AWS::InvalidSSOToken") {
                        return new InvalidSSOToken({
                          message: `AWS SSO credentials need to be refreshed. ${refreshHint(AWS_AUTH_PROVIDER_NAME, profileName)}`,
                          sso_session: error.sso_session,
                        });
                      }
                      return error;
                    }),
                  ),
                region,
                source: { type: "sso" as const, details: config.ssoProfile },
              } satisfies AwsResolvedCredentials;
            }),
          ),
          Match.exhaustive,
        )
        .pipe(
          // Pass diagnosable failures through untouched: NeedsReauth (stored
          // credentials missing) and the specific AuthErrors raised above
          // (missing SSO profile / sso_account_id / region) carry the real
          // diagnosis. Only genuinely unexpected failures (store I/O, the
          // STS accountId backfill) get wrapped.
          Effect.mapError((e) =>
            e._tag === "NeedsReauth" || e._tag === "AuthError"
              ? e
              : new AuthError({
                  message: "failed to resolve AWS credentials",
                  cause: e,
                }),
          ),
          Effect.flatMap(applyEnvRegionOverride),
          Effect.map(
            (creds): AwsResolvedCredentials => ({
              ...creds,
              credentials: creds.credentials.pipe(
                Effect.map((credentials) => ({
                  ...credentials,
                  region: creds.region,
                })),
              ),
            }),
          ),
        );

    const details = (profileName: string, config: AwsAuthConfig) =>
      Effect.gen(function* () {
        const creds = yield* resolveCredentials(profileName, config);
        // Resolve the live credentials. An expired/invalid SSO token only
        // surfaces here (the inner effect is lazy), so convert those tags
        // into a typed NeedsReauth instead of a generic error line.
        const { accessKeyId, secretAccessKey, sessionToken } =
          yield* creds.credentials.pipe(
            Effect.mapError((error) =>
              error._tag === "Alchemy::AWS::ExpiredSSOToken" ||
              error._tag === "Alchemy::AWS::InvalidSSOToken"
                ? needsReauth({
                    provider: AWS_AUTH_PROVIDER_NAME,
                    profile: profileName,
                    detail: "AWS SSO credentials need to be refreshed.",
                    cause: error,
                  })
                : new AuthError({
                    message: "failed to load AWS credentials",
                    cause: error,
                  }),
            ),
          );
        const lines: Array<ProviderDetailLine> = [
          { key: "accessKeyId", value: displayRedacted(accessKeyId) },
          { key: "secretAccessKey", value: displayRedacted(secretAccessKey) },
        ];
        if (sessionToken) {
          lines.push({
            key: "sessionToken",
            value: displayRedacted(sessionToken),
          });
        }
        if (creds.region) {
          lines.push({ key: "region", value: creds.region });
        }
        const source = creds.source;
        lines.push({
          key: "source",
          value:
            "details" in source
              ? `${source.type} - ${source.details}`
              : source.type,
        });
        return { lines };
      });

    const logout = (profileName: string, config: AwsAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "sso" }, (config) =>
          prompt.output
            .info(
              `AWS: running 'aws sso logout --profile ${config.ssoProfile}'...`,
            )
            .pipe(
              Effect.zip(runSsoCommand("logout", config.ssoProfile)),
              Effect.zip(clearDistilledSsoCache(config.ssoProfile)),
              Effect.match({
                onSuccess: () =>
                  prompt.output.success("AWS: SSO logout complete"),
                onFailure: (e) =>
                  prompt.output.warning(
                    `AWS: SSO logout failed: \`${e.message}\``,
                  ),
              }),
            ),
        ),
        Match.when({ method: "stored" }, () =>
          store
            .delete(profileName, STORAGE_KEY)
            .pipe(
              Effect.andThen(
                prompt.output.success("AWS: stored credentials removed"),
              ),
            ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: AwsAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "sso" }, loginSSO),
          Match.when({ method: "stored" }, () =>
            store
              .read(profileName, STORAGE_KEY, AwsStoredCredentials)
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

    const readEnvironment = Effect.gen(function* () {
      const accessKeyId = yield* getEnvRedactedRequired("AWS_ACCESS_KEY_ID");
      const secretAccessKey = yield* getEnvRedactedRequired(
        "AWS_SECRET_ACCESS_KEY",
      );
      const sessionToken = yield* getEnvRedacted("AWS_SESSION_TOKEN");
      const region = yield* getEnv("AWS_REGION").pipe(
        Effect.flatMap((value) =>
          value ? Effect.succeed(value) : getEnv("AWS_DEFAULT_REGION"),
        ),
      );
      if (!region) {
        return yield* new AuthError({
          message:
            "AWS CI region not found. Set AWS_REGION or AWS_DEFAULT_REGION.",
        });
      }
      const accountId = yield* getEnvRequired("AWS_ACCOUNT_ID").pipe(
        Effect.catch(() =>
          getAccountId({
            accessKeyId,
            secretAccessKey,
            sessionToken,
            region,
          }),
        ),
      );
      return {
        accountId,
        credentials: Effect.succeed({
          accessKeyId,
          secretAccessKey,
          sessionToken,
          region,
        }),
        region,
        source: { type: "env" as const },
      } satisfies AwsResolvedCredentials;
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof AuthError
          ? cause
          : new AuthError({
              message:
                "Failed to resolve AWS credentials from the CI environment.",
              cause,
            }),
      ),
    );

    return {
      configSchema: AwsAuthConfigSchema,
      configure: configureCredentials,
      configureWith,
      configureMethods,
      login,
      logout,
      details,
      read: resolveCredentials,
      readEnvironment,
      environment: [
        {
          name: "AWS_ACCESS_KEY_ID",
          required: true,
          secret: true,
        },
        {
          name: "AWS_SECRET_ACCESS_KEY",
          required: true,
          secret: true,
        },
        {
          name: "AWS_SESSION_TOKEN",
          required: false,
          secret: true,
          description: "Required when the access key is a temporary STS key.",
        },
        {
          name: "AWS_REGION",
          required: true,
          alternatives: ["AWS_DEFAULT_REGION"],
          description: "Region the stack deploys into.",
        },
        {
          name: "AWS_ACCOUNT_ID",
          required: false,
          description: "Derived via STS GetCallerIdentity when unset.",
        },
      ],
    };
  }),
);

const runSsoCommand = (command: "login" | "logout", ssoProfile: string) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(
      "aws",
      ["sso", command, "--profile", ssoProfile],
      {
        shell: false,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const exit = yield* handle.exitCode;
    if (exit !== 0) {
      return yield* new AuthError({
        message: `aws sso ${command} exited with code ${exit}`,
      });
    }
  }).pipe(Effect.scoped);

const loginSSO = (config: Extract<AwsAuthConfig, { method: "sso" }>) =>
  Effect.gen(function* () {
    const prompt = yield* CliKit.CliKit;
    yield* prompt.output.info(
      `AWS SSO: running 'aws sso login --profile ${config.ssoProfile}'...`,
    );
    yield* runSsoCommand("login", config.ssoProfile);
    yield* prompt.output.success("AWS SSO: login complete");
  });

/**
 * `aws sso logout` only clears AWS CLI's own caches — it does not know about the
 * `<sha1(sso_session)>.credentials.json` file that `@distilled.cloud/aws`
 * writes alongside the SSO token. Without this cleanup, `loadProfileCredentials`
 * short-circuits on the stale distilled cache file after logout and appears to
 * stay logged in until the role creds hit their TTL.
 */
const clearDistilledSsoCache = (ssoProfile: string) =>
  Effect.gen(function* () {
    const auth = yield* DistilledAuth.Default;
    const profile = yield* auth.loadProfile(ssoProfile);
    const ssoSession = (profile as { sso_session?: string }).sso_session;
    if (!ssoSession) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hash = NodeCrypto.createHash("sha1").update(ssoSession).digest("hex");
    const cacheFile = path.join(
      NodeOs.homedir(),
      ".aws",
      "sso",
      "cache",
      `${hash}.credentials.json`,
    );
    yield* fs.remove(cacheFile).pipe(Effect.catch(() => Effect.void));
  }).pipe(Effect.catch(() => Effect.void));
