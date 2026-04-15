import * as p from "@clack/prompts";
import * as DistilledAuth from "@distilled.cloud/aws/Auth";
import { Credentials as AwsCredentials } from "@distilled.cloud/aws/Credentials";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { spawn } from "node:child_process";
import { StageConfig } from "../../AWS/StageConfig.ts";
import type { AuthProvider } from "../AuthProvider.ts";
import {
  credentialsFilePath,
  deleteCredentials,
  displayRedacted,
  readCredentials,
  writeCredentials,
} from "../Credentials.ts";
import { prompt } from "../Prompt.ts";

export type AwsAuthConfig =
  | { method: "sso"; ssoProfile: string }
  | { method: "env"; profile?: string }
  | { method: "stored"; profile?: string };

export interface AwsStoredCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AwsResolvedCredentials {
  accessKeyId: Redacted.Redacted<string>;
  secretAccessKey: Redacted.Redacted<string>;
  sessionToken?: Redacted.Redacted<string>;
  source: string;
}

export class AwsLoginError extends Data.TaggedError("AwsLoginError")<{
  message: string;
}> {}

export { AwsCredentials };

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

export const resolveFromEnv: Effect.Effect<AwsResolvedCredentials | undefined> =
  Effect.gen(function* () {
    const accessKeyId = yield* optionalRedacted("AWS_ACCESS_KEY_ID");
    const secretAccessKey = yield* optionalRedacted("AWS_SECRET_ACCESS_KEY");
    if (!accessKeyId || !secretAccessKey) return undefined;
    const sessionToken = yield* optionalRedacted("AWS_SESSION_TOKEN");
    return {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
      source: "environment variables",
    };
  });

const resolveFromStored = (
  profileName: string,
): Effect.Effect<
  AwsResolvedCredentials | undefined,
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const creds = yield* readCredentials<AwsStoredCredentials>(
      profileName,
      "aws",
    );
    if (!creds) return undefined;
    return {
      accessKeyId: Redacted.make(creds.accessKeyId),
      secretAccessKey: Redacted.make(creds.secretAccessKey),
      ...(creds.sessionToken
        ? { sessionToken: Redacted.make(creds.sessionToken) }
        : {}),
      source: credentialsFilePath(profileName, "aws"),
    };
  });

/**
 * Prompt for AWS profile name (used for region/account lookup).
 * Returns:
 *   - `undefined` — user cancelled (Ctrl+C / escape)
 *   - `""`        — user skipped (Enter with no value); proceed without one
 *   - a string   — profile name to use
 */
const promptAwsProfile = (): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const envProfile = yield* optionalString("AWS_PROFILE");
    return yield* prompt(() =>
      p.text({
        message:
          "AWS profile name for region/account (from ~/.aws/config, Enter to skip)",
        placeholder: envProfile ?? "default",
        defaultValue: envProfile ?? "",
      }),
    );
  });

const runSsoCommand = (
  command: "login" | "logout",
  ssoProfile: string,
): Effect.Effect<void, AwsLoginError> =>
  Effect.callback<void, AwsLoginError>((resume) => {
    const proc = spawn("aws", ["sso", command, "--profile", ssoProfile], {
      stdio: "inherit",
    });
    proc.on("close", (code) => {
      if (code === 0) resume(Effect.void);
      else
        resume(
          Effect.fail(
            new AwsLoginError({
              message: `aws sso ${command} exited with code ${code}`,
            }),
          ),
        );
    });
    proc.on("error", (err) =>
      resume(Effect.fail(new AwsLoginError({ message: err.message }))),
    );
  });

const matchMethod = Match.discriminator("method");

const printAwsProfileInfo = (awsProfile: string | undefined) =>
  Effect.gen(function* () {
    if (!awsProfile) {
      const envRegion =
        (yield* optionalString("AWS_REGION")) ??
        (yield* optionalString("AWS_DEFAULT_REGION"));
      if (envRegion) {
        yield* Console.log(`  region: ${envRegion} (from env)`);
      } else {
        yield* Console.log("  region: (not set)");
      }
      return;
    }
    const result = yield* Effect.gen(function* () {
      const auth = yield* DistilledAuth.Default;
      return yield* auth.loadProfile(awsProfile);
    }).pipe(
      Effect.match({
        onFailure: (err) => ({ error: String(err) }) as { error: string },
        onSuccess: (profile) => profile,
      }),
    );
    if ("error" in result) {
      yield* Console.log(
        `  profile: ${awsProfile} (failed to load: ${result.error})`,
      );
      return;
    }
    yield* Console.log(`  profile: ${awsProfile}`);
    if (result.region) yield* Console.log(`  region:  ${result.region}`);
    if (result.sso_account_id)
      yield* Console.log(`  account: ${result.sso_account_id}`);
  });

const printCredentials = (creds: AwsResolvedCredentials) =>
  Effect.gen(function* () {
    yield* Console.log(`  accessKeyId:     ${displayRedacted(creds.accessKeyId)}`);
    yield* Console.log(
      `  secretAccessKey: ${displayRedacted(creds.secretAccessKey)}`,
    );
    if (creds.sessionToken) {
      yield* Console.log(
        `  sessionToken:    ${displayRedacted(creds.sessionToken)}`,
      );
    }
    yield* Console.log(`  source: ${creds.source}`);
  });

const getAwsProfileName = (config: AwsAuthConfig): string | undefined =>
  Match.value(config).pipe(
    matchMethod("sso", (c) => c.ssoProfile),
    matchMethod("env", (c) => c.profile),
    matchMethod("stored", (c) => c.profile),
    Match.exhaustive,
  );

/**
 * Single implementation of the AWS AuthProvider. Exposed as an Effect
 * that captures platform services (FileSystem, Path, HttpClient) and
 * returns an AuthProvider whose methods carry no requirements.
 */
export const AwsAuth: Effect.Effect<
  AuthProvider<AwsAuthConfig, AwsCredentials>,
  never,
  FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
> = Effect.gen(function* () {
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
  >();

  const provide = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
    >,
  ) => Effect.provideContext(effect, context);

  const provideLayer = <A>(
    layer: Layer.Layer<
      A,
      never,
      FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
    >,
  ) => Layer.provide(layer, Layer.succeedContext(context));

  return {
    name: "AWS",

    configure: (profileName, isReconfigure = false) =>
      Effect.orDie(
        provide(
          Effect.gen(function* () {
            const options: {
              value: "sso" | "env" | "stored" | "remove";
              label: string;
              hint?: string;
            }[] = [
              {
                value: "sso",
                label: "SSO",
                hint: "aws sso login — credentials loaded from AWS SSO cache",
              },
              {
                value: "env",
                label: "Environment Variables",
                hint: "AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY",
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
                hint: "remove AWS from this profile",
              });
            }

            const method = yield* prompt(() =>
              p.select({
                message: "AWS authentication method",
                options,
              }),
            );
            if (method === undefined) return undefined;

            return yield* Match.value(method).pipe(
              Match.when("remove", () => Effect.succeed("remove" as const)),
              Match.when("env", () =>
                Effect.gen(function* () {
                  const profile = yield* promptAwsProfile();
                  if (profile === undefined) return undefined;
                  return {
                    method: "env" as const,
                    ...(profile ? { profile } : {}),
                  };
                }),
              ),
              Match.when("sso", () =>
                Effect.gen(function* () {
                  const ssoProfile = yield* prompt(() =>
                    p.text({
                      message: "AWS profile name (from ~/.aws/config)",
                      placeholder: "default",
                      defaultValue: "default",
                    }),
                  );
                  if (ssoProfile === undefined) return undefined;
                  return {
                    method: "sso" as const,
                    ssoProfile: ssoProfile || "default",
                  };
                }),
              ),
              Match.when("stored", () =>
                Effect.gen(function* () {
                  const accessKeyId = yield* prompt(() =>
                    p.text({
                      message: "AWS Access Key ID",
                      validate: (v) =>
                        v.length === 0 ? "Required" : undefined,
                    }),
                  );
                  if (accessKeyId === undefined) return undefined;

                  const secretAccessKey = yield* prompt(() =>
                    p.password({
                      message: "AWS Secret Access Key",
                      validate: (v) =>
                        v.length === 0 ? "Required" : undefined,
                    }),
                  );
                  if (secretAccessKey === undefined) return undefined;

                  const sessionToken = yield* prompt(() =>
                    p.text({
                      message:
                        "AWS Session Token (optional — press Enter to skip)",
                      placeholder: "(none)",
                    }),
                  );
                  if (sessionToken === undefined) return undefined;

                  yield* writeCredentials<AwsStoredCredentials>(
                    profileName,
                    "aws",
                    {
                      accessKeyId,
                      secretAccessKey,
                      ...(sessionToken ? { sessionToken } : {}),
                    },
                  );
                  yield* Effect.sync(() =>
                    p.log.success("AWS credentials saved."),
                  );

                  const profile = yield* promptAwsProfile();
                  if (profile === undefined) return undefined;
                  return {
                    method: "stored" as const,
                    ...(profile ? { profile } : {}),
                  };
                }),
              ),
              Match.exhaustive,
            );
          }),
        ),
      ),

    login: (_profileName, config) =>
      provide(
        Match.value(config).pipe(
          matchMethod("sso", (c) =>
            Effect.gen(function* () {
              const stillValid = yield* DistilledAuth.loadProfileCredentials(
                c.ssoProfile,
              ).pipe(
                Effect.match({
                  onFailure: () => false,
                  onSuccess: () => true,
                }),
              );
              if (stillValid) {
                yield* Effect.sync(() =>
                  p.log.info(
                    `AWS SSO: profile '${c.ssoProfile}' already has valid credentials.`,
                  ),
                );
                return;
              }
              yield* Effect.sync(() =>
                p.log.info(
                  `AWS SSO: running 'aws sso login --profile ${c.ssoProfile}'...`,
                ),
              );
              yield* runSsoCommand("login", c.ssoProfile);
              yield* Effect.sync(() => p.log.success("AWS SSO login complete."));
            }).pipe(
              Effect.catchTag("AwsLoginError", (err) =>
                Effect.sync(() =>
                  p.log.error(`AWS SSO login failed: ${err.message}`),
                ),
              ),
            ),
          ),
          matchMethod("env", () =>
            Effect.sync(() =>
              p.log.info(
                "AWS: using environment variables — no login required.",
              ),
            ),
          ),
          matchMethod("stored", () =>
            Effect.sync(() =>
              p.log.info("AWS: using stored credentials — no login required."),
            ),
          ),
          Match.exhaustive,
        ),
      ),

    logout: (profileName, config) =>
      provide(
        Match.value(config).pipe(
          matchMethod("sso", (c) =>
            Effect.gen(function* () {
              yield* Effect.sync(() =>
                p.log.info(
                  `AWS SSO: running 'aws sso logout --profile ${c.ssoProfile}'...`,
                ),
              );
              const result = yield* runSsoCommand("logout", c.ssoProfile).pipe(
                Effect.match({
                  onFailure: () => "failed" as const,
                  onSuccess: () => "ok" as const,
                }),
              );
              if (result === "ok") {
                yield* Effect.sync(() =>
                  p.log.success("AWS SSO logout complete."),
                );
              } else {
                yield* Effect.sync(() =>
                  p.log.warn(
                    "AWS SSO logout failed (session may already be expired).",
                  ),
                );
              }
            }),
          ),
          matchMethod("stored", () =>
            Effect.gen(function* () {
              yield* deleteCredentials(profileName, "aws");
              yield* Effect.sync(() =>
                p.log.success("AWS stored credentials removed."),
              );
            }),
          ),
          matchMethod("env", () =>
            Effect.sync(() =>
              p.log.info(
                "AWS: using environment variables — nothing to log out of.",
              ),
            ),
          ),
          Match.exhaustive,
        ),
      ),

    prettyPrint: (profileName, config) =>
      provide(
        Match.value(config).pipe(
          matchMethod("env", (c) =>
            Effect.gen(function* () {
              yield* Console.log("AWS: env");
              const resolved = yield* resolveFromEnv;
              if (!resolved) {
                yield* Console.log("  AWS_ACCESS_KEY_ID:     (not set)");
                yield* Console.log("  AWS_SECRET_ACCESS_KEY: (not set)");
              } else {
                yield* printCredentials(resolved);
              }
              yield* printAwsProfileInfo(c.profile);
            }),
          ),
          matchMethod("stored", (c) =>
            Effect.gen(function* () {
              yield* Console.log("AWS: stored");
              const resolved = yield* resolveFromStored(profileName);
              if (!resolved) {
                yield* Console.log(
                  "  ERROR: credentials not found. Run: alchemy-effect login --configure",
                );
              } else {
                yield* printCredentials(resolved);
              }
              yield* printAwsProfileInfo(c.profile);
            }),
          ),
          matchMethod("sso", (c) =>
            Effect.gen(function* () {
              yield* Console.log(`AWS: sso (profile: ${c.ssoProfile})`);
              const ssoCredentials = yield* Effect.gen(function* () {
                const auth = yield* DistilledAuth.Default;
                const creds = yield* auth.loadProfileCredentials(c.ssoProfile);
                return {
                  accessKeyId: creds.accessKeyId,
                  secretAccessKey: creds.secretAccessKey,
                  sessionToken: creds.sessionToken,
                  source: "~/.aws/sso/cache",
                } as AwsResolvedCredentials;
              }).pipe(
                Effect.catch((err: unknown) =>
                  Effect.succeed({ error: String(err) } as { error: string }),
                ),
              );
              if ("error" in ssoCredentials) {
                yield* Console.log(`  ERROR: ${ssoCredentials.error}`);
                yield* Console.log(
                  `  Run: aws sso login --profile ${c.ssoProfile}`,
                );
              } else {
                yield* printCredentials(ssoCredentials);
              }
              yield* printAwsProfileInfo(c.ssoProfile);
            }),
          ),
          Match.exhaustive,
        ),
      ),

    credentialsLayer: (profileName, config) =>
      Match.value(config).pipe(
        matchMethod("sso", (c) =>
          provideLayer(
            Layer.effect(
              AwsCredentials,
              Effect.gen(function* () {
                const auth = yield* DistilledAuth.Default;
                return auth.loadProfileCredentials(c.ssoProfile);
              }),
            ),
          ),
        ),
        matchMethod("env", () =>
          Layer.unwrap(
            resolveFromEnv.pipe(
              Effect.map((resolved) => {
                if (!resolved) {
                  return Layer.effectDiscard(
                    Effect.die(
                      "AWS env credentials not found (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set)",
                    ),
                  ) as Layer.Layer<AwsCredentials>;
                }
                return Layer.succeed(
                  AwsCredentials,
                  Effect.succeed({
                    accessKeyId: resolved.accessKeyId,
                    secretAccessKey: resolved.secretAccessKey,
                    sessionToken: resolved.sessionToken,
                  }),
                );
              }),
            ),
          ),
        ),
        matchMethod("stored", () =>
          provideLayer(
            Layer.unwrap(
              readCredentials<AwsStoredCredentials>(profileName, "aws").pipe(
                Effect.map((creds) => {
                  if (!creds) {
                    return Layer.effectDiscard(
                      Effect.die(
                        "AWS stored credentials not found. Run: alchemy-effect login --configure",
                      ),
                    ) as Layer.Layer<AwsCredentials>;
                  }
                  return Layer.succeed(
                    AwsCredentials,
                    Effect.succeed({
                      accessKeyId: Redacted.make(creds.accessKeyId),
                      secretAccessKey: Redacted.make(creds.secretAccessKey),
                      sessionToken: creds.sessionToken
                        ? Redacted.make(creds.sessionToken)
                        : undefined,
                    }),
                  );
                }),
              ),
            ),
          ),
        ),
        Match.exhaustive,
      ),
  } satisfies AuthProvider<AwsAuthConfig, AwsCredentials>;
});

export const stageConfigLayer = (config: AwsAuthConfig) => {
  const awsProfile = getAwsProfileName(config);
  if (!awsProfile) {
    return Layer.succeed(StageConfig, {});
  }
  return Layer.effect(
    StageConfig,
    Effect.gen(function* () {
      const auth = yield* DistilledAuth.Default;
      const profile = yield* auth.loadProfile(awsProfile);
      return {
        profile: awsProfile,
        account: profile.sso_account_id,
        region: profile.region,
      };
    }),
  );
};
