import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive, withVcpus } from "../gates.ts";
import {
  appInsightsId,
  baseDefault,
  baseProject,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCompute = (
  resourceGroupName: string,
  workspaceName: string,
  computeName: string,
) =>
  Effect.gen(function* () {
    return yield* ml.GetCompute({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      computeName,
    });
  });

const program = (props: { tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const base = yield* baseProject();
    const compute = yield* Azure.MachineLearning.Compute("Dev", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      computeType: "ComputeInstance",
      vmSize: "Standard_DS11_v2",
      tags: props.tags,
    });
    return { ...base, compute };
  });

// A Standard_DS11_v2 compute instance (2 vCPUs, ~$0.19/hour, ~$0.10 per
// run). Two live runs exceeded the 15-minute budget (instance provisioning
// plus deletion of the instance and its hub/project), so it is gated.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a compute instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, compute } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const get = (name: string) =>
        getCompute(group.resourceGroupName, workspace.workspaceName, name);
      expect(compute.computeType).toEqual("ComputeInstance");
      expect(compute.vmSize?.toLowerCase()).toEqual("standard_ds11_v2");
      const observed = yield* get(compute.computeName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Dev");

      // In-place: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.compute.computeId).toEqual(compute.computeId);
      const reobserved = yield* get(compute.computeName);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* waitGone(get(compute.computeName))).toEqual("gone");
    }).pipe(withVcpus(2), logLevel),
  { tags, timeout: 900_000 },
);

// AmlCompute clusters are rejected by hub and project workspaces; they need
// a `Default` workspace, which requires an Application Insights component
// Alchemy cannot create yet. Set AZURE_ML_APP_INSIGHTS_ID to an existing
// component to run it. A cluster with minNodeCount 0 is free; ~6-10
// minutes including a replacement.
test.provider.skipIf(!runExpensive || !appInsightsId)(
  "create, update, replace, and delete an AmlCompute cluster",
  (stack) =>
    Effect.gen(function* () {
      const clusterProgram = (props: {
        vmSize: string;
        maxNodeCount: number;
        tags: Record<string, string>;
      }) =>
        Effect.gen(function* () {
          const base = yield* baseDefault();
          const compute = yield* Azure.MachineLearning.Compute("Cpu", {
            resourceGroup: base.group.resourceGroupName,
            workspace: base.workspace.workspaceName,
            vmSize: props.vmSize,
            vmPriority: "LowPriority",
            scaleSettings: {
              minNodeCount: 0,
              maxNodeCount: props.maxNodeCount,
              nodeIdleTimeBeforeScaleDown: "PT120S",
            },
            tags: props.tags,
          });
          return { ...base, compute };
        });
      const scaleOf = (compute: ml.GetComputeResponse) =>
        (
          compute.properties?.properties as {
            scaleSettings?: { maxNodeCount?: number };
          }
        )?.scaleSettings;

      yield* stack.destroy();
      const { group, workspace, compute } = yield* stack.deploy(
        clusterProgram({
          vmSize: "Standard_DS3_v2",
          maxNodeCount: 1,
          tags: { env: "test" },
        }),
      );
      const get = (name: string) =>
        getCompute(group.resourceGroupName, workspace.workspaceName, name);
      expect(compute.computeType).toEqual("AmlCompute");
      expect(scaleOf(yield* get(compute.computeName))?.maxNodeCount).toEqual(1);

      // In-place: autoscale settings and tags.
      const updated = yield* stack.deploy(
        clusterProgram({
          vmSize: "Standard_DS3_v2",
          maxNodeCount: 2,
          tags: { env: "prod" },
        }),
      );
      expect(updated.compute.computeId).toEqual(compute.computeId);
      const reobserved = yield* get(compute.computeName);
      expect(scaleOf(reobserved)?.maxNodeCount).toEqual(2);
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: a new VM size.
      const replaced = yield* stack.deploy(
        clusterProgram({
          vmSize: "Standard_DS2_v2",
          maxNodeCount: 2,
          tags: { env: "prod" },
        }),
      );
      expect(replaced.compute.computeName).not.toEqual(compute.computeName);
      expect(yield* waitGone(get(compute.computeName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.compute.computeName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
