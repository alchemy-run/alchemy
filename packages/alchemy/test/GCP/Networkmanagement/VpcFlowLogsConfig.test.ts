import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkmanagement from "@distilled.cloud/gcp/networkmanagement_v1";
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

// Network Management API is disabled on the default testing project
// (`Forbidden`: "Network Management API has not been used in project
// alchemy-gcp-testing-83661 before or it is disabled."). Set
// GCP_TEST_NETWORKMANAGEMENT=1 on an entitled project to run the full
// lifecycle.
const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  process.env.GCP_TEST_NETWORKMANAGEMENT === "1";
const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  networkmanagement.getProjectsLocationsVpcFlowLogsConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsVpcFlowLogsConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        networkmanagement.getProjectsLocationsVpcFlowLogsConfigs({
          name: `projects/${project}/locations/global/vpcFlowLogsConfigs/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || runLifecycle)(
  "create is rejected with Forbidden when the Network Management API is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        networkmanagement.createProjectsLocationsVpcFlowLogsConfigs({
          parent: `projects/${project}/locations/global`,
          vpcFlowLogsConfigId: "alchemy-vpc-flow-logs-probe",
          body: {
            state: "ENABLED",
            network: `projects/${project}/global/networks/alchemy-missing`,
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
  "create, update, and delete a vpc flow logs config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("FlowVpc", {
            autoCreateSubnetworks: false,
          });
          const logs = yield* GCP.Networkmanagement.VpcFlowLogsConfig(
            "VpcLogs",
            {
              network: network.selfLink ?? network.networkName,
              description: "flow logs a",
              labels: { env: "test" },
              aggregationInterval: "INTERVAL_5_SEC",
              flowSampling: 1,
            },
          );
          return { network, logs };
        }),
      );

      expect(created.logs.name).toContain("/vpcFlowLogsConfigs/");
      expect(created.logs.name).toContain("/locations/global/");
      expect(created.logs.vpcFlowLogsConfigId).toEqual(expect.any(String));
      expect(created.logs.location).toEqual("global");
      expect(created.logs.description).toEqual("flow logs a");
      expect(created.logs.labels).toMatchObject({ env: "test" });
      expect(created.logs.state).toEqual("ENABLED");
      expect(created.logs.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networkmanagement.getProjectsLocationsVpcFlowLogsConfigs({
          name: created.logs.name,
        });
      expect(fetched.name).toEqual(created.logs.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.description).toEqual("flow logs a");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("FlowVpc", {
            autoCreateSubnetworks: false,
            networkName: created.network.networkName,
          });
          const logs = yield* GCP.Networkmanagement.VpcFlowLogsConfig(
            "VpcLogs",
            {
              vpcFlowLogsConfigId: created.logs.vpcFlowLogsConfigId,
              network: network.selfLink ?? network.networkName,
              description: "flow logs b",
              labels: { env: "prod", role: "logs" },
              aggregationInterval: "INTERVAL_1_MIN",
              flowSampling: 0.5,
            },
          );
          return { network, logs };
        }),
      );

      expect(updated.logs.name).toEqual(created.logs.name);
      expect(updated.logs.description).toEqual("flow logs b");
      expect(updated.logs.labels).toMatchObject({ env: "prod", role: "logs" });
      expect(updated.logs.aggregationInterval).toEqual("INTERVAL_1_MIN");
      expect(updated.logs.flowSampling).toEqual(0.5);

      const refetched =
        yield* networkmanagement.getProjectsLocationsVpcFlowLogsConfigs({
          name: created.logs.name,
        });
      expect(refetched.description).toEqual("flow logs b");
      expect(refetched.aggregationInterval).toEqual("INTERVAL_1_MIN");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("logs");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.logs.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
