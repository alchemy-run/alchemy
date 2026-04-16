import * as DistilledAuth from "@distilled.cloud/aws/Auth";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  ChildProcess,
  type ChildProcessSpawner,
} from "effect/unstable/process";
import { AuthError, type AuthProvider } from "../AuthProvider.ts";
import * as Clank from "../Clank.ts";
import {
  deleteCredentials,
  displayRedacted,
  readCredentials,
  writeCredentials,
} from "../Credentials.ts";
import {
  getEnv,
  getEnvRedacted,
  getEnvRedactedRequired,
  retryOnce,
} from "../util.ts";

export type AwsAuthConfig =
  | { method: "sso"; ssoProfile: string }
  | { method: "stored"; storedAlias: string }
  | { method: "env" };

const options: Array<{
  value: AwsAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
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

export interface AwsStoredCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
}

export interface AwsResolvedCredentials {
  accessKeyId: Redacted.Redacted<string>;
  secretAccessKey: Redacted.Redacted<string>;
  sessionToken?: Redacted.Redacted<string>;
  region?: string;
  source: { type: AwsAuthConfig["method"]; details?: string };
}

export const AwsAuth = Effect.gen(function* () {
  const context = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | HttpClient.HttpClient
    | ChildProcessSpawner.ChildProcessSpawner
  >();

  return {
    name: "AWS",
    configure: (profileName: string) =>
      configureCredentials(profileName).pipe(Effect.provide(context)),

    logout: (profileName, config) =>
      logout(profileName, config).pipe(Effect.provide(context)),

    login: (profileName, config) =>
      login(profileName, config).pipe(Effect.provide(context)),

    prettyPrint: Effect.fnUntraced(function* (profileName, config) {
      yield* resolveCredentials(profileName, config).pipe(
        Effect.tap((creds) =>
          Effect.all([
            Console.log(
              `  accessKeyId:     ${displayRedacted(creds.accessKeyId)}`,
            ),
            Console.log(
              `  secretAccessKey: ${displayRedacted(creds.secretAccessKey)}`,
            ),
            creds.sessionToken
              ? Console.log(
                  `  sessionToken:    ${displayRedacted(creds.sessionToken)}`,
                )
              : Effect.void,
            creds.region
              ? Console.log(`  region:          ${creds.region}`)
              : Effect.void,
            Console.log(
              `  source: ${creds.source.details ? `${creds.source.type} - ${creds.source.details}` : creds.source.type}`,
            ),
          ]),
        ),
        Effect.catch((e) =>
          Console.error(`  Failed to retrieve credentials: ${e}`),
        ),
        Effect.provide(context),
      );
    }),

    read: (profileName, config) =>
      resolveCredentials(profileName, config).pipe(Effect.provide(context)),
  } satisfies AuthProvider<AwsAuthConfig, AwsResolvedCredentials>;
});

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
      yield* Effect.fail(
        new AuthError({
          message: `aws sso ${command} exited with code ${exit}`,
        }),
      );
    }
  }).pipe(Effect.scoped);

const resolveCredentials = (profileName: string, config: AwsAuthConfig) =>
  Match.value(config).pipe(
    Match.when(
      { method: "env" },
      Effect.fnUntraced(function* () {
        const accessKeyId = yield* getEnvRedactedRequired("AWS_ACCESS_KEY_ID");
        const secretAccessKey = yield* getEnvRedactedRequired(
          "AWS_SECRET_ACCESS_KEY",
        );
        const sessionToken = yield* getEnvRedacted("AWS_SESSION_TOKEN");
        const region = yield* (
          getEnv("AWS_REGION") ?? getEnv("AWS_DEFAULT_REGION") ?? undefined
        );
        return {
          accessKeyId,
          secretAccessKey,
          sessionToken,
          region,
          source: { type: "env" },
        } as AwsResolvedCredentials;
      }),
    ),
    Match.when({ method: "stored" }, (config) =>
      readCredentials<AwsStoredCredentials>(
        profileName,
        `aws-${config.storedAlias}`,
      ).pipe(
        Effect.flatMap((creds) =>
          creds == null
            ? Effect.die(
                "AWS stored credentials not found. Run: alchemy-effect login --configure",
              )
            : Effect.succeed({
                accessKeyId: Redacted.make(creds.accessKeyId),
                secretAccessKey: Redacted.make(creds.secretAccessKey),
                sessionToken: creds.sessionToken
                  ? Redacted.make(creds.sessionToken)
                  : undefined,
                region: creds.region,
                source: { type: "stored", details: config.storedAlias },
              } as AwsResolvedCredentials),
        ),
      ),
    ),
    Match.when({ method: "sso" }, (config) =>
      Effect.gen(function* () {
        const auth = yield* DistilledAuth.Default;
        const creds = yield* auth
          .loadProfileCredentials(config.ssoProfile)
          .pipe(
            Effect.mapError(
              (e) =>
                new AuthError({
                  message: "failed to load credentials",
                  cause: e,
                }),
            ),
          );
        const profile = yield* auth
          .loadProfile(config.ssoProfile)
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        return {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
          region: profile?.region,
          source: { type: "sso", details: config.ssoProfile },
        } as AwsResolvedCredentials;
      }),
    ),
    Match.exhaustive,
  );

const logout = (profileName: string, config: AwsAuthConfig) =>
  Match.value(config).pipe(
    Match.when({ method: "env" }, () => Effect.void),
    Match.when({ method: "sso" }, (config) =>
      Clank.info(
        `AWS SSO: running 'aws sso logout --profile ${config.ssoProfile}'...`,
      ).pipe(
        Effect.andThen(runSsoCommand("logout", config.ssoProfile)),
        Effect.matchEffect({
          onSuccess: () => Clank.success("AWS SSO: logout complete"),
          onFailure: (e) =>
            Clank.warn(`AWS SSO: logut faield: \`${e.message}\``),
        }),
      ),
    ),
    Match.when({ method: "stored" }, (config) =>
      deleteCredentials(profileName, `aws-${config.storedAlias}`).pipe(
        Effect.andThen(Clank.success("AWS stored credentials removed")),
      ),
    ),
    Match.exhaustive,
  );

const login = (profileName: string, config: AwsAuthConfig) =>
  Match.value(config)
    .pipe(
      Match.when({ method: "env" }, () => Effect.void),
      Match.when({ method: "sso" }, (config) =>
        DistilledAuth.loadProfileCredentials(config.ssoProfile).pipe(
          Effect.matchEffect({
            onSuccess: () =>
              Clank.info(
                `AWS SSO: profile '${config.ssoProfile}' already has valid credentials.`,
              ),
            onFailure: () => loginSSO(config),
          }),
        ),
      ),
      Match.when({ method: "stored" }, (config) =>
        readCredentials<AwsStoredCredentials>(
          profileName,
          `aws-${config.storedAlias}`,
        ).pipe(
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

const configureCredentials = (profileName: string) =>
  Effect.gen(function* () {
    const method = yield* Clank.select({
      message: "AWS authentication method",
      options,
    });
    if (method === undefined) {
      return yield* new AuthError({ message: "User cancelled AWS login" });
    }

    return yield* Match.value(method).pipe(
      Match.when("env", () => Effect.succeed({ method: "env" as const })),
      Match.when("sso", () =>
        Effect.gen(function* () {
          const ssoProfile = yield* Clank.text({
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
    );
  }).pipe(Effect.orDie);

const loginSSO = (config: Extract<AwsAuthConfig, { method: "sso" }>) =>
  Clank.info(
    `AWS SSO: running 'aws sso login --profile ${config.ssoProfile}'...`,
  ).pipe(
    Effect.andThen(runSsoCommand("login", config.ssoProfile)),
    Effect.matchEffect({
      onSuccess: () => Clank.success("AWS SSO: login complete"),
      onFailure: (e) => Clank.warn(`AWS SSO: login faield: \`${e.message}\``),
    }),
  );

const loginStored = Effect.fnUntraced(function* (profileName: string) {
  const alias = yield* Clank.text({
    message: "AWS Access Key ID",
    validate: (v) => (v.length === 0 ? "Required" : undefined),
  }).pipe(retryOnce);

  const accessKeyId = yield* Clank.text({
    message: "AWS Access Key ID",
    validate: (v) => (v.length === 0 ? "Required" : undefined),
  }).pipe(retryOnce);

  const secretAccessKey = yield* Clank.password({
    message: "AWS Secret Access Key",
    validate: (v) => (v.length === 0 ? "Required" : undefined),
  }).pipe(retryOnce);

  const sessionToken = yield* Clank.text({
    message: "AWS Session Token (optional — press Enter to skip)",
    placeholder: "(none)",
  }).pipe(retryOnce);

  const region = yield* Clank.text({
    message: "AWS Region",
    placeholder: "us-east-1",
    defaultValue: "us-east-1",
    validate: (v) => (v.length === 0 ? "Required" : undefined),
  }).pipe(retryOnce);

  yield* writeCredentials<AwsStoredCredentials>(profileName, `aws-${alias}`, {
    accessKeyId,
    secretAccessKey,
    sessionToken,
    region,
  });
  yield* Clank.success("AWS credentials saved.");

  return { method: "stored" as const, storedAlias: alias };
});
