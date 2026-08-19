/**
 * Run the live AWS suites for services that have a Floci local provider
 * (`flociDual` / `ProviderLayer.dual` in Providers.ts) under
 * `ALCHEMY_TEST_DEV=1`.
 *
 * Dedicated `*.local.test.ts` files are excluded — those already set
 * `Test.make({ dev: true })` and some use `Alchemy.remote()` for out-of-band
 * live checks, which this env would redirect onto the emulator.
 *
 * Extra alchemy-test args are forwarded (`-t`, `--retry`, paths, …).
 */
import { Glob } from "bun";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const alchemyRoot = join(repoRoot, "packages/alchemy");
const awsTestRoot = join(alchemyRoot, "test/AWS");
const providersFile = join(alchemyRoot, "src/AWS/Providers.ts");

const extraDirs: Record<string, ReadonlyArray<string>> = {
  SecretsManager: ["Secret"],
};

const dualizedServices = (): string[] => {
  const source = readFileSync(providersFile, "utf8");
  const names = new Set<string>(["Local"]);
  const pattern = /(?:flociDual|ProviderLayer\.dual)\(\s*([A-Za-z0-9]+)\./g;
  for (const match of source.matchAll(pattern)) {
    const service = match[1]!;
    names.add(service);
    for (const extra of extraDirs[service] ?? []) names.add(extra);
  }
  return [...names].sort();
};

const flagsWithValue = new Set([
  "-t",
  "--test-name-pattern",
  "--timeout",
  "--retry",
  "--concurrency",
  "-c",
  "--profile",
]);

const flags: string[] = [];
const paths: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg.startsWith("-")) {
    flags.push(arg);
    if (flagsWithValue.has(arg) && args[i + 1] && !args[i + 1]!.startsWith("-")) {
      flags.push(args[++i]!);
    }
    continue;
  }
  paths.push(arg);
}

const allowedRoots = dualizedServices()
  .map((service) => join(awsTestRoot, service))
  .filter((dir) => existsSync(dir));

if (allowedRoots.length === 0) {
  console.error("test:aws:floci: no dualized AWS service test dirs found");
  process.exit(1);
}

const requestedRoots =
  paths.length > 0 ? paths.map((p) => resolve(alchemyRoot, p)) : allowedRoots;

const files: string[] = [];
for (const root of requestedRoots) {
  if (!existsSync(root)) {
    files.push(relative(alchemyRoot, root));
    continue;
  }
  if (statSync(root).isFile()) {
    files.push(relative(alchemyRoot, root));
    continue;
  }
  const glob = new Glob("**/*.test.ts");
  for await (const file of glob.scan(root)) {
    if (file.endsWith(".local.test.ts")) continue;
    files.push(relative(alchemyRoot, join(root, file)));
  }
}

process.env.ALCHEMY_TEST_DEV = "1";
process.env.ALCHEMY_FLOCI_IMAGE ??= "floci:dev";

if (!flags.includes("--profile")) {
  flags.unshift("--profile", "testing");
}
if (!flags.includes("--concurrency") && !flags.includes("-c")) {
  // Every concurrent file deploys real stacks against the LOCAL emulator:
  // each Lambda cold start is a Docker container on this machine. The old
  // default of 200 (tuned while the env bug made this script run against
  // live AWS, where concurrency is free) cold-starts hundreds of containers
  // at once and OOMs the host. 64 keeps the Docker footprint bounded.
  flags.unshift("--concurrency", "64");
}

const proc = Bun.spawn(["bun", "alchemy-test", ...files.sort(), ...flags], {
  cwd: alchemyRoot,
  // Bun.spawn's default env is a snapshot taken at process start, so the
  // `process.env.ALCHEMY_TEST_DEV` mutations above never reach the child
  // unless the env is materialized explicitly. Without this the "floci"
  // suite silently runs live against real AWS.
  env: { ...process.env },
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});
process.exit(await proc.exited);
