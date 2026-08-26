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
  composer.getProjectsLocationsEnvironmentsUserWorkloadsSecrets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsEnvironmentsUserWorkloadsSecrets on a missing secret fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        composer.getProjectsLocationsEnvironmentsUserWorkloadsSecrets({
          name: `${missingParent}/userWorkloadsSecrets/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const created = yield* Effect.flip(
        composer.createProjectsLocationsEnvironmentsUserWorkloadsSecrets({
          parent: missingParent,
          body: {
            name: `${missingParent}/userWorkloadsSecrets/alchemy-missing`,
            data: { password: btoa("s3cret") },
          },
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(created._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a user workloads secret",
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
          const secret = yield* GCP.Composer.EnvironmentsUserWorkloadsSecret(
            "TaskSecret",
            {
              environmentName: airflow.name,
              data: { password: btoa("s3cret") },
            },
          );
          return { airflow, secret };
        }),
      );

      expect(created.secret.name).toContain("/userWorkloadsSecrets/");
      expect(created.secret.environmentName).toEqual(created.airflow.name);
      expect(created.secret.data["alchemy-id"]).toBeUndefined();

      const fetched =
        yield* composer.getProjectsLocationsEnvironmentsUserWorkloadsSecrets({
          name: created.secret.name,
        });
      expect(fetched.name).toEqual(created.secret.name);
      expect(fetched.data?.["alchemy-id"]).toBeDefined();

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
          const secret = yield* GCP.Composer.EnvironmentsUserWorkloadsSecret(
            "TaskSecret",
            {
              environmentName: airflow.name,
              secretId: created.secret.secretId,
              data: { password: btoa("rotated"), token: btoa("abc123") },
            },
          );
          return { airflow, secret };
        }),
      );

      expect(updated.secret.name).toEqual(created.secret.name);

      const refetched =
        yield* composer.getProjectsLocationsEnvironmentsUserWorkloadsSecrets({
          name: created.secret.name,
        });
      expect(Object.keys(refetched.data ?? {})).toEqual(
        expect.arrayContaining(["password", "token", "alchemy-id"]),
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.secret.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
