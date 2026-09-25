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

const missingParent = `projects/${project}/locations/us-central1/environments/alchemy-composer-missing`;

const waitUntilGone = (name: string) =>
  composer
    .getProjectsLocationsEnvironmentsUserWorkloadsConfigMaps({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsEnvironmentsUserWorkloadsConfigMaps on a missing config map fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        composer.getProjectsLocationsEnvironmentsUserWorkloadsConfigMaps({
          name: `${missingParent}/userWorkloadsConfigMaps/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const created = yield* Effect.flip(
        composer.createProjectsLocationsEnvironmentsUserWorkloadsConfigMaps({
          parent: missingParent,
          body: {
            name: `${missingParent}/userWorkloadsConfigMaps/alchemy-missing`,
            data: { LOG_LEVEL: "INFO" },
          },
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(created._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a user workloads config map",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const airflow = yield* GCP.Composer.Environment("Airflow", {
            location: "us-central1",
            config: {
              environmentSize: "ENVIRONMENT_SIZE_SMALL",
              softwareConfig: { imageVersion: "composer-3-airflow-2" },
            },
          });
          const config = yield* GCP.Composer.EnvironmentsUserWorkloadsConfigMap(
            "TaskConfig",
            {
              environmentName: airflow.name,
              data: { LOG_LEVEL: "INFO" },
            },
          );
          return { airflow, config };
        }),
      );

      expect(created.config.name).toContain("/userWorkloadsConfigMaps/");
      expect(created.config.environmentName).toEqual(created.airflow.name);
      expect(created.config.data).toMatchObject({ LOG_LEVEL: "INFO" });
      expect(created.config.data["alchemy-id"]).toBeUndefined();

      const fetched =
        yield* composer.getProjectsLocationsEnvironmentsUserWorkloadsConfigMaps(
          { name: created.config.name },
        );
      expect(fetched.name).toEqual(created.config.name);
      expect(fetched.data?.LOG_LEVEL).toEqual("INFO");
      expect(fetched.data?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const airflow = yield* GCP.Composer.Environment("Airflow", {
            environmentId: created.airflow.environmentId,
            location: "us-central1",
            config: {
              environmentSize: "ENVIRONMENT_SIZE_SMALL",
              softwareConfig: { imageVersion: "composer-3-airflow-2" },
            },
          });
          const config = yield* GCP.Composer.EnvironmentsUserWorkloadsConfigMap(
            "TaskConfig",
            {
              environmentName: airflow.name,
              configMapId: created.config.configMapId,
              data: { LOG_LEVEL: "DEBUG", REGION: "us-central1" },
            },
          );
          return { airflow, config };
        }),
      );

      expect(updated.config.name).toEqual(created.config.name);
      expect(updated.config.data).toMatchObject({
        LOG_LEVEL: "DEBUG",
        REGION: "us-central1",
      });

      const refetched =
        yield* composer.getProjectsLocationsEnvironmentsUserWorkloadsConfigMaps(
          { name: created.config.name },
        );
      expect(refetched.data?.LOG_LEVEL).toEqual("DEBUG");
      expect(refetched.data?.REGION).toEqual("us-central1");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.config.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
