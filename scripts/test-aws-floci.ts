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
 * `--list` prints selected files without starting tests or touching Floci.
 * `--external` uses an existing server without Docker fallback or state reset.
 * `--dry-run` prints the resolved command without starting tests or touching Floci.
 * Shared state is preserved unless `--reset-shared` is explicitly passed.
 */
import { Glob } from "bun";
import { preferLocalFlociImage } from "./floci-image.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const alchemyRoot = join(repoRoot, "packages/alchemy");
const awsTestRoot = join(alchemyRoot, "test/AWS");
const providersFile = join(alchemyRoot, "src/AWS/Providers.ts");

const extraDirs: Record<string, ReadonlyArray<string>> = {
  SecretsManager: ["Secret"],
};

// The other Organizations suites require a pre-existing management account or
// the live-only Account provider. Keep automatic discovery on the local fixture.
const serviceSuites: Record<string, ReadonlyArray<string>> = {
  Organizations: ["Organization.test.ts"],
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
let listOnly = false;
let dryRun = false;
let resetShared = false;
let external = process.env.ALCHEMY_FLOCI_EXTERNAL === "1";
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--external") {
    external = true;
    continue;
  }
  if (arg === "--dry-run") {
    dryRun = true;
    continue;
  }
  if (arg === "--reset-shared") {
    resetShared = true;
    continue;
  }
  if (arg === "--list") {
    listOnly = true;
    continue;
  }
  if (arg.startsWith("-")) {
    flags.push(arg);
    if (
      flagsWithValue.has(arg) &&
      args[i + 1] &&
      !args[i + 1]!.startsWith("-")
    ) {
      flags.push(args[++i]!);
    }
    continue;
  }
  paths.push(arg);
}

const allowedRoots = dualizedServices()
  .flatMap((service) =>
    (serviceSuites[service] ?? [""]).map((suite) =>
      join(awsTestRoot, service, suite),
    ),
  )
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

if (listOnly) {
  console.log([...new Set(files)].sort().join("\n"));
  process.exit(0);
}

const fail = (message: string): never => {
  console.error(`test:aws:floci: ${message}`);
  process.exit(1);
};

if (resetShared && (external || process.env.ALCHEMY_FLOCI_NO_RESET)) {
  fail("--reset-shared conflicts with --external or ALCHEMY_FLOCI_NO_RESET");
}

// Local providers currently use this gateway regardless of SDK overrides.
const endpointError =
  "AWS_ENDPOINT_URL must be http://localhost:4566; isolated gateways are not supported yet";
const endpointValue = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
if (!URL.canParse(endpointValue)) fail(endpointError);
const endpoint = new URL(endpointValue);
if (
  endpoint.protocol !== "http:" ||
  !["localhost", "127.0.0.1"].includes(endpoint.hostname) ||
  endpoint.port !== "4566" ||
  endpoint.pathname !== "/" ||
  endpoint.search ||
  endpoint.hash ||
  endpoint.username ||
  endpoint.password
) {
  fail(endpointError);
}

const hasFlag = (...names: string[]) =>
  flags.some((flag) =>
    names.some((name) => flag === name || flag.startsWith(`${name}=`)),
  );
if (!hasFlag("--profile")) flags.unshift("--profile", "testing");
if (!hasFlag("--concurrency", "-c")) flags.unshift("--concurrency", "4");
const command = ["bun", "alchemy-test", ...new Set(files.sort()), ...flags];
if (dryRun) {
  console.log(
    JSON.stringify({
      command,
      cwd: alchemyRoot,
      external,
      resetShared,
      endpoint: "http://localhost:4566",
    }),
  );
  process.exit(0);
}

process.env.ALCHEMY_TEST_DEV = "1";
process.env.AWS_ENDPOINT_URL = "http://localhost:4566";
if (external) {
  process.env.ALCHEMY_FLOCI_EXTERNAL = "1";
  console.log(
    "test:aws:floci: using the existing Floci server (no Docker fallback)",
  );
} else {
  preferLocalFlociImage("test:aws:floci");
}

if (resetShared) {
  try {
    const res = await fetch("http://localhost:4566/_floci/state/reset", {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok)
      fail(
        `emulator state reset returned ${res.status}; tests were not started`,
      );
    console.log("test:aws:floci: reset shared emulator state");
  } catch (error) {
    fail(
      `could not reset emulator state: ${error instanceof Error ? error.message : String(error)}; tests were not started`,
    );
  }
} else {
  console.log("test:aws:floci: preserving shared emulator state");
}

const proc = Bun.spawn(command, {
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
