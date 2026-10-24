import * as Azure from "@alchemy.run/azure";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { testCertificate, testNodeTypes } from "../ServiceFabricClassic/util.ts";
import { labUserFixture, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getFabric = (resourceGroupName: string, labName: string, userName: string, name: string) =>
  Effect.gen(function* () {
    return yield* devtestlabs.GetServiceFabric({
      subscriptionId: yield* subscription,
      resourceGroupName,
      labName,
      userName,
      name,
    });
  });

const program = (props: { cluster: "First" | "Second"; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const { group, lab, user } = yield* labUserFixture();
    // Classic clusters without node scale sets stay in `WaitingForNodes`
    // and bill nothing. Both stay deployed across the replacement step.
    const first = yield* Azure.ServiceFabricClassic.Cluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      reliabilityLevel: "None",
      vmImage: "Windows",
      certificate: testCertificate,
      nodeTypes: testNodeTypes(),
    });
    const second = yield* Azure.ServiceFabricClassic.Cluster("Cluster2", {
      resourceGroup: group.resourceGroupName,
      reliabilityLevel: "None",
      vmImage: "Windows",
      certificate: testCertificate,
      nodeTypes: testNodeTypes(),
    });
    const cluster = props.cluster === "First" ? first : second;
    const fabric = yield* Azure.DevTestLabs.ServiceFabric("Fabric", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      user: user.userName,
      externalServiceFabricId: cluster.clusterResourceId,
      tags: props.tags,
    });
    return { group, lab, user, cluster, fabric };
  });

// A free lab, a lab user, and two node-less classic clusters (free); the
// lab takes 2-5 minutes, the clusters 1-2 in parallel.
test.provider(
  "create, update, replace, and delete a lab service fabric registration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lab, user, cluster, fabric } = yield* stack.deploy(
        program({ cluster: "First", tags: { env: "test" } }),
      );
      const get = (name: string) =>
        getFabric(group.resourceGroupName, lab.labName, user.userName, name);
      const observed = yield* get(fabric.serviceFabricName);
      expect(observed.properties?.externalServiceFabricId?.toLowerCase()).toEqual(
        cluster.clusterResourceId.toLowerCase(),
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Fabric");

      // In-place: tags.
      const updated = yield* stack.deploy(program({ cluster: "First", tags: { env: "prod" } }));
      expect(updated.fabric.serviceFabricId).toEqual(fabric.serviceFabricId);
      const retagged = yield* get(fabric.serviceFabricName);
      expect(retagged.tags?.env).toEqual("prod");

      // Replacement: a different cluster.
      const replaced = yield* stack.deploy(program({ cluster: "Second", tags: { env: "prod" } }));
      expect(replaced.fabric.serviceFabricName).not.toEqual(fabric.serviceFabricName);
      const moved = yield* get(replaced.fabric.serviceFabricName);
      expect(moved.properties?.externalServiceFabricId?.toLowerCase()).toEqual(
        replaced.cluster.clusterResourceId.toLowerCase(),
      );
      expect(yield* waitGone(get(fabric.serviceFabricName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.fabric.serviceFabricName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
