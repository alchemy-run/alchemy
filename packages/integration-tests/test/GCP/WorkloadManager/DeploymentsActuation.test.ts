import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as workloadmanager from "@distilled.cloud/gcp/workloadmanager_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const parentOf = (project: string) => `projects/${project}/locations/us-central1`;
const missingDeploymentOf = (project: string) =>
  `${parentOf(project)}/deployments/alchemy-missing-deployment`;

// The testing project doesn't enable workloadmanager.googleapis.com by default: every test
// deploys it first.
const WorkloadManagerApi = GCP.ServiceUsage.ProjectService("WorkloadManagerApi", {
  service: "workloadmanager.googleapis.com",
});

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

test.provider(
  "getProjectsLocationsDeploymentsActuations on a missing actuation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const missingDeployment = missingDeploymentOf(project);
      yield* stack.destroy();
      yield* stack.deploy(WorkloadManagerApi);

      const error = yield* Effect.flip(
        workloadmanager.getProjectsLocationsDeploymentsActuations({
          name: `${missingDeployment}/actuations/alchemy-missing-actuation`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:workloadmanager", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create against a missing deployment is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const missingDeployment = missingDeploymentOf(project);
      yield* stack.destroy();
      yield* stack.deploy(WorkloadManagerApi);

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            yield* WorkloadManagerApi;
            return yield* GCP.WorkloadManager.DeploymentsActuation("Bootstrap", {
              deployment: missingDeployment,
            });
          }),
        ),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:workloadmanager", "live"],
    timeout: 90_000,
  },
);

// An actuation runs under a Workload Manager deployment: an SAP system rollout
// that provisions its own infrastructure. Set GCP_TEST_WORKLOADMANAGER_DEPLOYMENT
// to an existing deployment to run this lifecycle.
test.provider.skipIf(!process.env.GCP_TEST_WORKLOADMANAGER_DEPLOYMENT)(
  "create and delete an actuation under an entitled deployment",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      yield* stack.deploy(WorkloadManagerApi);

      const deploymentName = process.env.GCP_TEST_WORKLOADMANAGER_DEPLOYMENT;
      expect(deploymentName).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          yield* WorkloadManagerApi;
          return yield* GCP.WorkloadManager.DeploymentsActuation("Bootstrap", {
            deployment: deploymentName!,
          });
        }),
      );

      expect(created.name).toContain("/actuations/");
      expect(created.actuationId).toEqual(expect.any(String));
      expect(created.deployment).toEqual(deploymentName);
      expect(created.project).toEqual(project);

      const fetched = yield* workloadmanager.getProjectsLocationsDeploymentsActuations({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:workloadmanager", "live"],
    timeout: 120_000,
  },
);
