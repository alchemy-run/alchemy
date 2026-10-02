import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cs from "@distilled.cloud/azure/containerservice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { withPublicIps, withVcpus } from "../gates.ts";
import { logLevel, tags, testCluster, untilGone } from "./cluster.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPool = (
  resourceGroupName: string,
  resourceName: string,
  agentPoolName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* cs.GetAgentPool({
      subscriptionId,
      resourceGroupName,
      resourceName,
      agentPoolName,
    });
  });

const program = (props: {
  vmSize: string;
  nodeLabels: Record<string, string>;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, cluster } = yield* testCluster("westus3");
    // A User pool with zero nodes costs nothing and uses no vCPU quota.
    const pool = yield* Azure.ContainerService.AgentPool("Pool", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.clusterName,
      vmSize: props.vmSize,
      count: 0,
      nodeLabels: props.nodeLabels,
      tags: props.tags,
    });
    return { group, cluster, pool };
  });

// Test cluster (~6 min create, ~5 min delete, ~$0.03) plus a zero-node
// User pool (free, ~2 min per step). Replacement (e.g. a vmSize change)
// would add two more pool operations and exceed the 15-minute budget.
test.provider(
  "create, update, and delete an agent pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          vmSize: "Standard_D2s_v7",
          nodeLabels: { workload: "batch" },
          tags: { env: "test" },
        }),
      );
      const { group, cluster, pool } = created;
      expect(pool.mode).toEqual("User");
      expect(pool.count).toEqual(0);
      expect(pool.agentPoolName).toMatch(/^[a-z][a-z0-9]{0,11}$/);
      const observed = yield* getPool(
        group.resourceGroupName,
        cluster.clusterName,
        pool.agentPoolName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.nodeLabels?.workload).toEqual("batch");
      expect(observed.properties?.tags?.env).toEqual("test");
      expect(observed.properties?.tags?.["alchemy::id"]).toEqual("Pool");

      const updated = yield* stack.deploy(
        program({
          vmSize: "Standard_D2s_v7",
          nodeLabels: { workload: "web" },
          tags: { env: "prod" },
        }),
      );
      expect(updated.pool.agentPoolName).toEqual(pool.agentPoolName);
      expect(updated.pool.nodeLabels).toEqual({ workload: "web" });
      expect(updated.pool.tags).toEqual({ env: "prod" });
      const reobserved = yield* getPool(
        group.resourceGroupName,
        cluster.clusterName,
        pool.agentPoolName,
      );
      expect(reobserved.properties?.nodeLabels?.workload).toEqual("web");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getPool(
            group.resourceGroupName,
            cluster.clusterName,
            pool.agentPoolName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withPublicIps(1), withVcpus(2), logLevel),
  { tags: [...tags], timeout: 900_000 },
);
