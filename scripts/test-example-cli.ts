import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const example = process.argv[2];
if (example === undefined) {
  throw new Error("Usage: bun scripts/test-example-cli.ts <example-directory>");
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const exampleRoot = path.resolve(repositoryRoot, example);
const alchemyBin = path.join(
  repositoryRoot,
  "packages",
  "alchemy",
  "bin",
  "alchemy.ts",
);
const stage = "cli-example-test";
const timeoutMs = 10 * 60_000;
const alchemyHome = fs.mkdtempSync(
  path.join(os.tmpdir(), "alchemy-example-cli-"),
);
const childEnv = {
  ...process.env,
  ALCHEMY_HOME: alchemyHome,
  ALCHEMY_PROFILE: undefined,
  AWS_PROFILE: undefined,
  CI: "true",
  NO_COLOR: "1",
};

type CommandResult = {
  readonly exitCode: number | null;
  readonly output: string;
};

const command = (name: "dev" | "deploy" | "destroy") => [
  "bun",
  alchemyBin,
  name,
  "--stage",
  stage,
  "--no-input",
  ...(name === "dev" ? [] : ["--yes"]),
];

const run = (
  name: "deploy" | "destroy",
  timeout = timeoutMs,
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command(name)[0]!, command(name).slice(1), {
      cwd: exampleRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (process.env.DEBUG) process.stderr.write(text);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.once("error", reject);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, output });
    });
  });

const runDev = (): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command("dev")[0]!, command("dev").slice(1), {
      cwd: exampleRoot,
      detached: true,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    let ready = false;

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The CLI and its process group have already exited.
      }
    };
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, output });
    };
    const append = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (process.env.DEBUG) process.stderr.write(text);
      if (
        !ready &&
        (output.includes("Dev stack ready") || output.includes("No changes"))
      ) {
        ready = true;
        killGroup("SIGINT");
        setTimeout(() => killGroup("SIGKILL"), 15_000).unref();
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", reject);
    child.once("exit", (exitCode) => finish(ready ? 0 : exitCode));
    const timer = setTimeout(() => {
      output += `\nTimed out after ${timeoutMs / 1000}s waiting for alchemy dev to become ready.`;
      killGroup("SIGKILL");
    }, timeoutMs);
  });

const assertSuccess = (
  name: "dev" | "deploy" | "destroy",
  result: CommandResult,
) => {
  if (result.exitCode !== 0) {
    throw new Error(
      `${example}: alchemy ${name} failed (exit ${result.exitCode ?? "signal"})\n${result.output}`,
    );
  }
};

const assertOutput = (
  name: "dev" | "deploy" | "destroy",
  result: CommandResult,
  expected: readonly RegExp[],
) => {
  for (const pattern of expected) {
    if (!pattern.test(result.output)) {
      throw new Error(
        `${example}: alchemy ${name} output did not match ${pattern}\n${result.output}`,
      );
    }
  }
};

let primaryFailure: unknown;
try {
  const dev = await runDev();
  assertSuccess("dev", dev);
  assertOutput("dev", dev, [/Dev stack ready/, /Outputs/, /https?:\/\//]);

  const deployed = await run("deploy");
  assertSuccess("deploy", deployed);
  assertOutput("deploy", deployed, [
    /Stack deployed/,
    /Outputs/,
    /https?:\/\//,
  ]);
} catch (error) {
  primaryFailure = error;
} finally {
  try {
    const destroyed = await run("destroy");
    if (destroyed.exitCode !== 0 && primaryFailure === undefined) {
      primaryFailure = new Error(
        `${example}: alchemy destroy failed (exit ${destroyed.exitCode ?? "signal"})\n${destroyed.output}`,
      );
    } else if (destroyed.exitCode !== 0) {
      console.error(
        `${example}: cleanup destroy also failed\n${destroyed.output}`,
      );
    } else if (primaryFailure === undefined) {
      assertOutput("destroy", destroyed, [/Stack destroyed/]);
    }
  } catch (error) {
    if (primaryFailure === undefined) primaryFailure = error;
    else console.error(`${example}: cleanup destroy failed`, error);
  } finally {
    fs.rmSync(alchemyHome, { recursive: true, force: true });
  }
}

if (primaryFailure !== undefined) throw primaryFailure;
