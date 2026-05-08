import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Command from "effect/unstable/cli/Command";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";
import { envFile, force, profile, script, stage } from "./_shared.ts";
import { ExecStackOptions } from "./deploy.ts";

export const devCommand = Command.make(
  "dev",
  {
    force,
    main: script,
    envFile,
    stage,
    profile,
  },
  Effect.fn(function* (args) {
    const options = yield* Schema.encodeEffect(ExecStackOptions)({
      ...args,
      yes: true,
      dev: true,
    });
    // We no longer force Bun in development because this prevents us from testing in Node.
    const command =
      typeof globalThis.Bun !== "undefined"
        ? [
            "bun",
            "run",
            ...process.execArgv,
            "--watch",
            "--no-clear-screen",
            fileURLToPath(import.meta.resolve("alchemy/bin/exec.ts")),
          ]
        : [
            "node",
            ...process.execArgv,
            "--experimental-transform-types",
            "--watch",
            "--watch-preserve-output",
            fileURLToPath(import.meta.resolve("alchemy/bin/exec.js")),
          ];
    const child = yield* ChildProcess.make(command[0], command.slice(1), {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ALCHEMY_EXEC_OPTIONS: JSON.stringify(options),
      },
      extendEnv: true,
      detached: false,
    });
    yield* child.exitCode;
  }),
);
