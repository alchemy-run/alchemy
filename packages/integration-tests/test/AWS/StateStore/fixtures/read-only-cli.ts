import { fileURLToPath } from "node:url";
import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import type * as IAM from "@alchemy.run/aws/IAM";
import * as sts from "@distilled.cloud/aws/sts";
import type { Input } from "alchemy/Input";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

/**
 * Run `alchemy plan` and `alchemy drift` on `read-only-state.ts` as a role
 * that can only read the state store (#2751).
 */

const CLI = fileURLToPath(new URL("../../../../../alchemy/bin/cli.js", import.meta.url));
/** The CLI discovers providers from this package's `package.json`. */
const PROJECT = fileURLToPath(new URL("../../../..", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./read-only-state.ts", import.meta.url));

/** The stack name `read-only-state.ts` declares. */
export const READ_ONLY_STACK = "ReadOnlyState";

/** A role the account can assume, allowed only `statements`. */
export const ReadOnlyRole = (statements: Input<IAM.PolicyStatement>[]) =>
  Effect.gen(function* () {
    const { accountId } = yield* AWSEnvironment.current;
    return yield* AWS.IAM.Role("ReadStateRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${accountId}:root` },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: { ReadState: { Version: "2012-10-17", Statement: statements } },
    });
  });

/** Run the CLI non-interactively with only `env`'s AWS credentials. */
const runCli = (args: ReadonlyArray<string>, env: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-read-only-state-" });
    const { ALCHEMY_PROFILE: _, AWS_PROFILE: __, ...inherited } = process.env;
    const handle = yield* ChildProcess.make("bun", [CLI, ...args], {
      cwd: PROJECT,
      env: { ...inherited, ALCHEMY_HOME: home, CI: "1", NO_COLOR: "1", ...env },
      extendEnv: false,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: "1 second",
    });
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.decodeText, Stream.mkString),
        handle.stderr.pipe(Stream.decodeText, Stream.mkString),
        handle.exitCode,
      ],
      { concurrency: 3 },
    );
    return { output: `${stdout}${stderr}`, exitCode };
  }).pipe(Effect.scoped, Effect.provide(PlatformServices));

/**
 * Assume `roleArn`, then run `command` (`plan` or `drift`) on the fixture
 * stack at `stage`, its store configured by `store` (the fixture's env).
 */
export const runAsReadOnlyRole = Effect.fn(function* (
  roleArn: string,
  command: "plan" | "drift",
  stage: string,
  store: Record<string, string>,
) {
  const { region } = yield* AWSEnvironment.current;
  // A freshly created role's trust policy takes a few seconds to apply.
  const { Credentials: credentials } = yield* sts
    .assumeRole({ RoleArn: roleArn, RoleSessionName: "alchemy-read-only-state" })
    .pipe(
      Effect.retry({
        while: (error) => error._tag === "AccessDeniedException",
        schedule: Schedule.exponential("1 second"),
        times: 8,
      }),
    );
  const env = {
    ...store,
    AWS_ACCESS_KEY_ID: credentials!.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: Redacted.isRedacted(credentials!.SecretAccessKey)
      ? Redacted.value(credentials!.SecretAccessKey)
      : credentials!.SecretAccessKey,
    AWS_SESSION_TOKEN: credentials!.SessionToken,
    AWS_REGION: region,
  };
  // The role's policy can lag its trust policy, so a denied read is
  // retried. A denied write fails every attempt.
  return yield* runCli([command, "--config", FIXTURE, "--stage", stage], env).pipe(
    Effect.repeat({
      until: ({ exitCode, output }) =>
        exitCode === 0 ||
        !/not authorized to perform: (s3:(GetObject|ListBucket)|dynamodb:)/.test(output),
      schedule: Schedule.spaced("3 seconds"),
      times: 5,
    }),
  );
});
