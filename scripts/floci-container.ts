/**
 * Start the managed Floci container with the settings `test:aws:floci`
 * suites rely on, before any test file runs.
 *
 * `ensureFloci` reuses a running container when its image and requested
 * ports match; it does not compare environment settings. A container started
 * earlier without these settings (e.g. by `alchemy dev`) is therefore removed
 * first, so the suites never run against an emulator configured differently
 * from the one they were validated on.
 */
import * as Floci from "@alchemy.run/aws/Local/Floci";
import * as Effect from "effect/Effect";

/** Emulator settings the suites assume, mirroring a real AWS account. */
export const flociTestEnv: Readonly<Record<string, string>> = {
  // Real S3 evaluates IAM; the denied-read suites assert that behavior.
  FLOCI_SERVICES_S3_ENFORCE_AUTH: "true",
  // Every real AWS account has a primary contact.
  FLOCI_SERVICES_ACCOUNT_BOOTSTRAP_CONTACT_INFORMATION: JSON.stringify({
    FullName: "Local AWS account",
    AddressLine1: "1 Example Street",
    City: "Seattle",
    StateOrRegion: "WA",
    PostalCode: "98101",
    CountryCode: "US",
    PhoneNumber: "+12025550100",
  }),
};

const containerEnv = (name: string): Set<string> | undefined => {
  const inspect = Bun.spawnSync(["docker", "inspect", "--format", "{{json .Config.Env}}", name], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (inspect.exitCode !== 0) return undefined;
  return new Set(JSON.parse(inspect.stdout.toString()) as string[]);
};

export const startFlociForTests = async (label: string): Promise<void> => {
  const name = Floci.DEFAULT_CONTAINER_NAME;
  const env = containerEnv(name);
  const missing = Object.entries(flociTestEnv).filter(
    ([key, value]) => !env?.has(`${key}=${value}`),
  );
  if (env !== undefined && missing.length > 0) {
    console.log(`${label}: recreating ${name}; it lacks ${missing.map(([key]) => key).join(", ")}`);
    Bun.spawnSync(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" });
  }
  await Effect.runPromise(
    Floci.ensureFloci({ port: Floci.DEFAULT_FLOCI_PORT, env: { ...flociTestEnv } }),
  );
};
