import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as composer from "@distilled.cloud/gcp/composer_v1";
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
  hasGcpCreds && !!process.env.GCP_TEST_COMPOSER && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  composer.getProjectsLocationsEnvironments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsEnvironments on a missing environment fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        composer.getProjectsLocationsEnvironments({
          name: `projects/${project}/locations/us-central1/environments/alchemy-composer-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* composer.listProjectsLocationsEnvironments({
        parent: `projects/${project}/locations/us-central1`,
        pageSize: 10,
      });
      expect(Array.isArray(page.environments ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a composer environment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Composer.Environment("Airflow", {
            location: "us-central1",
            labels: { env: "test" },
            config: {
              environmentSize: "ENVIRONMENT_SIZE_SMALL",
              softwareConfig: { imageVersion: "composer-3-airflow-2" },
            },
          });
        }),
      );

      expect(created.name).toContain("/environments/");
      expect(created.environmentId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.state).toEqual("RUNNING");

      const fetched = yield* composer.getProjectsLocationsEnvironments({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.state).toEqual("RUNNING");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Composer.Environment("Airflow", {
            environmentId: created.environmentId,
            location: "us-central1",
            labels: { env: "prod", role: "airflow" },
            config: {
              environmentSize: "ENVIRONMENT_SIZE_SMALL",
              softwareConfig: { imageVersion: "composer-3-airflow-2" },
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "airflow" });

      const refetched = yield* composer.getProjectsLocationsEnvironments({
        name: created.name,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("airflow");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
