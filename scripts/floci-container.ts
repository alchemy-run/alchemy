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
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

/**
 * Where the container reads the AI services' canned answers. Floci's
 * Translate, Comprehend, Textract and Rekognition run no models; a request
 * that has an entry in this file (`scripts/floci-ai-mocks.json`, copied in at
 * start) gets it: Translate keys by the text, Textract by the document's
 * `sha256:<hex>`, so a document matches whatever bucket it was uploaded to.
 */
const AI_MOCK_CONFIG = "/tmp/alchemy-ai-mocks.json";

/** Emulator settings the suites assume, mirroring a real AWS account. */
export const flociTestEnv: Readonly<Record<string, string>> = {
  AI_MOCK_CONFIG,
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

/** The running container's environment, or undefined when there is none. */
const containerEnv = Effect.fn(function* (name: string) {
  const spawner = yield* ChildProcessSpawner;
  const output = yield* spawner
    .string(
      ChildProcess.make("docker", ["inspect", "--format", "{{json .Config.Env}}", name], {
        stdin: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(Effect.option);
  if (output._tag === "None") return undefined;
  return yield* Effect.try(() => new Set(JSON.parse(output.value) as string[])).pipe(
    Effect.orElseSucceed(() => undefined),
  );
});

export const startFlociForTests = Effect.fn(function* (label: string, image?: string) {
  const spawner = yield* ChildProcessSpawner;
  const name = Floci.DEFAULT_CONTAINER_NAME;
  const env = yield* containerEnv(name);
  const missing = Object.entries(flociTestEnv).filter(
    ([key, value]) => !env?.has(`${key}=${value}`),
  );
  if (env !== undefined && missing.length > 0) {
    yield* Console.log(
      `${label}: recreating ${name}; it lacks ${missing.map(([key]) => key).join(", ")}`,
    );
    yield* spawner
      .exitCode(
        ChildProcess.make("docker", ["rm", "-f", name], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(Effect.ignore);
  }
  // `managed: true` means the container was just started, so the emulator's
  // state is new; a reused one reports `managed: false`.
  const instance = yield* Floci.ensureFloci({
    port: Floci.DEFAULT_FLOCI_PORT,
    image,
    env: { ...flociTestEnv },
  });
  // Floci re-reads the file when it changes, so copying it into a running
  // container takes effect at once.
  const mocks = new URL("./floci-ai-mocks.json", import.meta.url).pathname;
  yield* spawner.exitCode(
    ChildProcess.make("docker", ["cp", mocks, `${name}:${AI_MOCK_CONFIG}`], {
      stdin: "ignore",
      stdout: "ignore",
    }),
  );
  return instance;
});
