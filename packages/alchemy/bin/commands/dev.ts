import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Command from "effect/unstable/cli/Command";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";
import { envFile, force, main, profile, stage } from "./_shared.ts";
import { ExecStackOptions } from "./deploy.ts";

export const devCommand = Command.make(
  "dev",
  {
    force,
    main,
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
    const bin = typeof globalThis.Bun !== "undefined" ? "bun" : "node";
    const child = yield* ChildProcess.make(
      bin,
      [
        "run",
        "--watch",
        "--no-clear-screen",
        fileURLToPath(import.meta.resolve("../exec.ts")),
      ],
      {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: {
          ALCHEMY_EXEC_OPTIONS: JSON.stringify(options),
        },
        extendEnv: true,
      },
    );
    yield* child.exitCode;
  }),
);
