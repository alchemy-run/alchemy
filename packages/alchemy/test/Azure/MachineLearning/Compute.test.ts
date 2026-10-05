import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive, withVcpus } from "../gates.ts";
import { baseDefault, logLevel, subscription, tags, waitGone } from "./util.ts";

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
    const base = yield* baseDefault();
    const compute = yield* Azure.MachineLearning.Compute("Dev", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      computeType: "ComputeInstance",
      vmSize: "Standard_D2s_v3",
      tags: props.tags,
    });
    return { ...base, compute };
  });

// A Standard_D2s_v3 compute instance (2 vCPUs, ~$0.10/hour, ~$0.10 per
// run) in a `Default` workspace, gated (~30-40 minutes per run). On the
// alchemy-testing subscription every compute instance (D2s_v3, D2as_v4,
// E2s_v3, F2s_v2, D2ds_v5, DS11_v2; hub project or `Default` workspace;
// shared or assigned to a user; SSO on or off) stays in 'Creating' with no
// provisioning error past the 25-minute wait, so this fails until Azure
// support resolves it.
// Skipped: failed in the last live run. Azure.ProvisioningTimedOut: machine learning compute
// clwjofbhf3aaquni did not reach 'Succeeded' after 150 polls (last state: Creating)
test.provider.skip(
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
      expect(compute.vmSize?.toLowerCase()).toEqual("standard_d2s_v3");
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
  { tags, timeout: 3_600_000 },
);

// AmlCompute clusters are rejected by hub and project workspaces; they need
// a `Default` workspace (with a template-deployed Application Insights
// component). A cluster with minNodeCount 0 is free; ~6-10
// minutes including a replacement (needs 4 dedicated DSv2 ML cores).
test.provider.skipIf(!runExpensive)(
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
            // Low-priority ML core quota is 0 on new subscriptions
            // (ClusterMinNodesExceedCoreQuota); dedicated nodes cost
            // nothing at minNodeCount 0.
            vmPriority: "Dedicated",
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
