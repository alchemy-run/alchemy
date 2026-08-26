import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_REGIONAL_SECRETS && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  secretmanager.getProjectsLocationsSecrets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "BadRequest"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "createProjectsLocationsSecrets on the global endpoint fails with BadRequest",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* Effect.flip(
        secretmanager.createProjectsLocationsSecrets({
          parent: `projects/${project}/locations/us-central1`,
          secretId: "alchemy-regional-probe",
          body: { labels: { env: "probe" } },
        }),
      );
      expect(["BadRequest", "Forbidden", "NotFound"]).toContain(error._tag);
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a regional secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecretManager.LocationsSecret("ApiKey", {
            location: "us-central1",
            labels: { env: "test" },
            annotations: { owner: "payments" },
          });
        }),
      );

      expect(created.name).toContain("/locations/us-central1/secrets/");
      expect(created.secretId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.annotations).toMatchObject({ owner: "payments" });

      const fetched = yield* secretmanager.getProjectsLocationsSecrets({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(fetched.annotations?.owner).toEqual("payments");

      const payload = yield* Effect.sync(() =>
        Buffer.from("alchemy-regional-secret", "utf8").toString("base64"),
      );
      const version = yield* secretmanager.addVersionProjectsLocationsSecrets({
        parent: created.name,
        body: { payload: { data: payload } },
      });
      expect(version.name).toContain("/versions/");

      const accessed =
        yield* secretmanager.accessProjectsLocationsSecretsVersions({
          name: `${created.name}/versions/latest`,
        });
      expect(accessed.payload?.data).toEqual(payload);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecretManager.LocationsSecret("ApiKey", {
            secretId: created.secretId,
            location: "us-central1",
            labels: { env: "prod", role: "api" },
            annotations: { owner: "platform" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "api" });
      expect(updated.annotations).toMatchObject({ owner: "platform" });

      const fetchedUpdate = yield* secretmanager.getProjectsLocationsSecrets({
        name: created.name,
      });
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.role).toEqual("api");
      expect(fetchedUpdate.annotations?.owner).toEqual("platform");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "replace a regional secret when location changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecretManager.LocationsSecret("RegionalKey", {
            location: "us-central1",
          });
        }),
      );

      expect(created.location).toEqual("us-central1");
      expect(created.name).toContain("/locations/us-central1/secrets/");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecretManager.LocationsSecret("RegionalKey", {
            secretId: created.secretId,
            location: "us-east1",
          });
        }),
      );

      expect(replaced.secretId).toEqual(created.secretId);
      expect(replaced.location).toEqual("us-east1");
      expect(replaced.name).toContain("/locations/us-east1/secrets/");
      expect(replaced.name).not.toEqual(created.name);

      const fetched = yield* secretmanager.getProjectsLocationsSecrets({
        name: replaced.name,
      });
      expect(fetched.name).toEqual(replaced.name);

      const oldGone = yield* waitUntilGone(created.name);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
