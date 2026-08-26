import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as workloadmanager from "@distilled.cloud/gcp/workloadmanager_v1";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const parent = `projects/${project}/locations/us-central1`;
const missingDeployment = `${parent}/deployments/alchemy-missing-deployment`;

// Workload Manager API is entitlement-gated on the default testing project
// (`Forbidden`: "Workload Manager API has not been used in project
// alchemy-gcp-testing-83661 before or it is disabled."). Set
// GCP_TEST_WORKLOADMANAGER=1 on an entitled project to run the lifecycle.
const entitled = process.env.GCP_TEST_WORKLOADMANAGER === "1";
const runLifecycle = hasGcpCreds && entitled && !process.env.FAST;

const waitUntilGone = (name: string) =>
  workloadmanager.getProjectsLocationsDeploymentsActuations({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsDeploymentsActuations on a missing actuation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        workloadmanager.getProjectsLocationsDeploymentsActuations({
          name: `${missingDeployment}/actuations/alchemy-missing-actuation`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message).toContain(
          "Workload Manager API has not been used",
        );
      }

      const page = yield* workloadmanager
        .listProjectsLocationsDeploymentsActuations({
          parent: missingDeployment,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ actuations: [] as const }),
          ),
        );
      expect(Array.isArray(page.actuations ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || entitled)(
  "createProjectsLocationsDeploymentsActuations is rejected with Forbidden when Workload Manager is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        workloadmanager.createProjectsLocationsDeploymentsActuations({
          parent: missingDeployment,
          body: {
            name: `${missingDeployment}/actuations/alchemy-actuation-probe`,
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toContain("has not been used in project");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create against a missing deployment is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Workloadmanager.DeploymentsActuation(
              "Bootstrap",
              {
                deployment: missingDeployment,
              },
            );
          }),
        ),
      );
      expect([
        "BadRequest",
        "NotFound",
        "Forbidden",
        "GCP.Workloadmanager.OperationFailed",
        "GCP.Workloadmanager.ResourceFailed",
        "GCP.Workloadmanager.ResourceNotReady",
        "GCP.Workloadmanager.ResourceNotResolved",
      ]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(
  !runLifecycle || !process.env.GCP_TEST_WORKLOADMANAGER_DEPLOYMENT,
)(
  "create and delete an actuation under an entitled deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploymentName = process.env.GCP_TEST_WORKLOADMANAGER_DEPLOYMENT;
      expect(deploymentName).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Workloadmanager.DeploymentsActuation("Bootstrap", {
            deployment: deploymentName!,
          });
        }),
      );

      expect(created.name).toContain("/actuations/");
      expect(created.actuationId).toEqual(expect.any(String));
      expect(created.deployment).toEqual(deploymentName);
      expect(created.project).toEqual(project);

      const fetched =
        yield* workloadmanager.getProjectsLocationsDeploymentsActuations({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
