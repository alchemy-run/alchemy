import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as batch from "@distilled.cloud/azure/batch";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, regions, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPool = (
  resourceGroupName: string,
  accountName: string,
  poolName: string,
) =>
  Effect.gen(function* () {
    return yield* batch.GetPool({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accountName,
      poolName,
    });
  });

const ubuntu = {
  imageReference: {
    publisher: "canonical",
    offer: "0001-com-ubuntu-server-jammy",
    sku: "22_04-lts",
    version: "latest",
  },
  nodeAgentSkuId: "batch.node.ubuntu 22.04",
};

const program = (props: {
  vmSize: string;
  metadata: Record<string, string>;
  startTask?: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: regions.pool,
    });
    const account = yield* Azure.Batch.Account("Jobs", {
      resourceGroup: group.resourceGroupName,
      location: regions.pool,
    });
    const pool = yield* Azure.Batch.Pool("Workers", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      vmSize: props.vmSize,
      virtualMachineConfiguration: ubuntu,
      scaleSettings: { fixedScale: { targetDedicatedNodes: 0 } },
      metadata: props.metadata,
      startTask: props.startTask
        ? { commandLine: props.startTask, waitForSuccess: true }
        : undefined,
      tags: props.tags,
    });
    return { group, account, pool };
  });

// Pools stay at 0 nodes, so no VM ever bills: $0.
test.provider(
  "create, update, replace, and delete a batch pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, pool } = yield* stack.deploy(
        program({
          vmSize: "Standard_A1_v2",
          metadata: { stage: "v1" },
          tags: { team: "render" },
        }),
      );
      expect(pool.allocationState).toEqual("Steady");
      expect(pool.currentDedicatedNodes).toEqual(0);
      expect(pool.metadata).toEqual({ stage: "v1" });
      expect(pool.tags).toEqual({ team: "render" });
      const get = (name: string) =>
        getPool(group.resourceGroupName, account.accountName, name);
      const observed = yield* get(pool.poolName);
      expect(observed.properties?.vmSize?.toLowerCase()).toEqual(
        "standard_a1_v2",
      );
      expect(observed.tags?.["alchemy::id"]).toEqual("Workers");

      // In-place: metadata, start task, and tags.
      const updated = yield* stack.deploy(
        program({
          vmSize: "Standard_A1_v2",
          metadata: { stage: "v2" },
          startTask: "/bin/sh -c 'echo ready'",
          tags: { team: "encode" },
        }),
      );
      expect(updated.pool.poolId).toEqual(pool.poolId);
      expect(updated.pool.metadata).toEqual({ stage: "v2" });
      const after = yield* get(pool.poolName);
      expect(after.properties?.startTask?.commandLine).toEqual(
        "/bin/sh -c 'echo ready'",
      );
      expect(after.tags?.team).toEqual("encode");

      // Replacement: VM size is immutable.
      const replaced = yield* stack.deploy(
        program({
          vmSize: "Standard_A2_v2",
          metadata: { stage: "v2" },
          tags: { team: "encode" },
        }),
      );
      expect(replaced.pool.poolName).not.toEqual(pool.poolName);
      expect(replaced.pool.vmSize?.toLowerCase()).toEqual("standard_a2_v2");
      expect(
        (yield* get(replaced.pool.poolName)).properties?.startTask?.commandLine,
      ).toBeUndefined();
      expect(yield* waitGone(get(pool.poolName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.pool.poolName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
