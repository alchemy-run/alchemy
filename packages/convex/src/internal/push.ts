import { stripVTControlCharacters } from "node:util";
import { redactText } from "alchemy/Util/Redaction";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { findConvexCli } from "./cli.ts";

/** Where `convex deploy` pushes, and the credential it pushes with. */
export type PushTarget =
  | { readonly kind: "cloud"; readonly url: string; readonly deployKey: Redacted.Redacted<string> }
  | {
      readonly kind: "selfHosted";
      readonly url: string;
      readonly adminKey: Redacted.Redacted<string>;
    };

/** `convex deploy` failed, or exited 0 without saying where it pushed. */
export class CodePushFailed extends Data.TaggedError("CodePushFailed")<{
  readonly message: string;
  readonly exitCode: number | undefined;
  /** The last lines of the CLI output, with every secret removed. */
  readonly outputTail: string;
}> {}

/** The CLI pushed somewhere other than the target. */
export class PushTargetMismatch extends Data.TaggedError("PushTargetMismatch")<{
  readonly message: string;
  readonly expected: string;
  readonly actual: string;
}> {}

const DEPLOYED_LINE = /Deployed Convex functions to (https?:\/\/\S+)/;
const TAIL_LINES = 20;
const MIN_SECRET_LENGTH = 8;
const HOME_VARIABLES = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"] as const;

/** The origin the CLI reports in its "Deployed Convex functions to <url>" line. */
export const parseDeployedUrl = (output: string): string | undefined => {
  const match = DEPLOYED_LINE.exec(stripVTControlCharacters(output))?.[1];
  return match !== undefined && URL.canParse(match) ? new URL(match).origin : undefined;
};

/**
 * The CLI's environment: this process's variables without any `CONVEX_*`
 * name, which could select another deployment, and with `home` as the home
 * directory, so the CLI can't read a login saved on this machine.
 */
export const cliEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].toUpperCase().startsWith("CONVEX_"),
    ),
  ),
  ...Object.fromEntries(HOME_VARIABLES.map((name) => [name, home])),
});

/** The last lines of `output`, without colour codes and with every secret replaced. */
export const redactOutput = (output: string, secrets: ReadonlyArray<string>): string =>
  redactText(
    stripVTControlCharacters(output),
    secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH),
    "[REDACTED]",
  )
    .split(/\r?\n|\r/)
    .filter((line) => line.trim() !== "")
    .slice(-TAIL_LINES)
    .join("\n");

const envFileOf = (target: PushTarget) =>
  target.kind === "cloud"
    ? `CONVEX_DEPLOY_KEY=${Redacted.value(target.deployKey)}\n`
    : `CONVEX_SELF_HOSTED_URL=${target.url}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${Redacted.value(target.adminKey)}\n`;

const secretOf = (target: PushTarget) =>
  Redacted.value(target.kind === "cloud" ? target.deployKey : target.adminKey);

/**
 * Runs the app's own `convex deploy` against `target` and returns the origin
 * it pushed to. The CLI gets its credentials only from an env file in a fresh
 * temporary home directory, removed afterwards whatever happens.
 */
export const runConvexDeploy = Effect.fn(function* (input: {
  readonly rootDir: string;
  readonly target: PushTarget;
  /** More values to keep out of the error text, such as secret variables. */
  readonly secrets: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cli = yield* findConvexCli(input.rootDir);
  const secret = secretOf(input.target);
  const secrets = [secret, secret.slice(secret.indexOf("|") + 1), ...input.secrets];
  const expected = new URL(input.target.url).origin;

  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-convex-push-" });
      const envFile = path.join(home, "deploy.env");
      yield* fs.writeFileString(envFile, envFileOf(input.target), { mode: 0o600 });
      const parent = yield* Effect.sync(() => ({ ...process.env }));
      const child = yield* spawner.spawn(
        ChildProcess.make(cli, ["deploy", "--yes", "--env-file", envFile], {
          cwd: path.resolve(input.rootDir),
          env: cliEnvironment(parent, home),
          extendEnv: false,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode,
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
        ],
        { concurrency: "unbounded" },
      );
      return { exitCode: Number(exitCode), output: `${stdout}\n${stderr}` };
    }),
  );

  const actual = parseDeployedUrl(result.output);
  if (result.exitCode !== 0 || actual === undefined) {
    const outputTail = redactOutput(result.output, secrets);
    return yield* new CodePushFailed({
      exitCode: result.exitCode,
      outputTail,
      message:
        result.exitCode === 0
          ? `convex deploy exited 0 but never said where it pushed. Last output:\n${outputTail}`
          : `convex deploy failed with exit code ${result.exitCode}. Last output:\n${outputTail}`,
    });
  }
  if (actual !== expected) {
    return yield* new PushTargetMismatch({
      expected,
      actual,
      message: `convex deploy pushed to ${actual}, not ${expected}. Check that convex.json or .env.local in the app folder does not select another deployment.`,
    });
  }
  return actual;
});
