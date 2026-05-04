import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Command from "effect/unstable/cli/Command";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";
import { envFile, force, profile, script, stage } from "./_shared.ts";
import { ExecStackOptions } from "./deploy.ts";

// Source iteration uses unbundled exec.ts so --watch sees source-file changes;
// published installs use the bundled exec.js so react/ink/pathe stay
// devDependencies (matching the CLI bundle's intent). Detect which world we're
// in by whether dev.ts (or the alchemy.js bundle that contains it) lives
// inside a node_modules tree — same heuristic as bin/cli.js.
const selfPath = fileURLToPath(import.meta.url);
const isInstalled =
  selfPath.includes("/node_modules/") || selfPath.includes("\\node_modules\\");
const execEntry = isInstalled ? "alchemy/bin/exec.js" : "alchemy/bin/exec.ts";

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
    const bin = typeof globalThis.Bun !== "undefined" ? "bun" : "node";
    const child = yield* ChildProcess.make(
      bin,
      [
        "run",
        "--watch",
        "--no-clear-screen",
        fileURLToPath(import.meta.resolve(execEntry)),
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
