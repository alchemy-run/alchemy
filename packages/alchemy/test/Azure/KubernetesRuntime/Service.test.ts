import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hk from "@distilled.cloud/azure/hybridkubernetes";
import * as kr from "@distilled.cloud/azure/kubernetesruntime";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { STUB_AGENT_PUBLIC_KEY } from "./fixtures.ts";
import { arcClusterId, logLevel, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getService = (clusterId: string, serviceName: string) =>
  kr.GetService({ resourceUri: clusterId, serviceName });

const program = (
  serviceName: Azure.KubernetesRuntime.KubernetesRuntimeServiceName,
) =>
  Effect.gen(function* () {
    const service = yield* Azure.KubernetesRuntime.Service("Runtime", {
      clusterId: arcClusterId!,
      serviceName,
    });
    return { service };
  });

// Needs a connected Arc cluster (see util.ts); the service itself is free.
test.provider.skipIf(!arcClusterId)(
  "create, replace, and delete a kubernetes runtime service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const clusterId = arcClusterId!;

      const { service } = yield* stack.deploy(program("storageclass"));
      expect(service.serviceName).toEqual("storageclass");
      expect(service.provisioningState).toEqual("Succeeded");
      const observed = yield* getService(clusterId, "storageclass");
      expect(observed.id?.toLowerCase()).toEqual(
        service.serviceId.toLowerCase(),
      );

      // Replacement: the feature name is the identity.
      const replaced = yield* stack.deploy(program("networking"));
      expect(replaced.service.serviceName).toEqual("networking");
      const networking = yield* getService(clusterId, "networking");
      expect(networking.properties?.provisioningState).toEqual("Succeeded");
      expect(yield* waitGone(getService(clusterId, "storageclass"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* waitGone(getService(clusterId, "networking"))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Free: an ARM-only connected cluster that never connects. Pins the typed
// not-found that read/delete rely on and the idempotent delete.
test.provider(
  "runtime extension reads are typed not-found and deletes are idempotent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const cluster = yield* hk.ConnectedClusterCreateOrReplace({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        clusterName: "stub",
        location: "eastus",
        identity: { type: "SystemAssigned" },
        properties: { agentPublicKeyCertificate: STUB_AGENT_PUBLIC_KEY },
      });
      const clusterId = cluster.id!;

      const missing = yield* getService(clusterId, "storageclass").pipe(
        Effect.flip,
      );
      expect(missing._tag).toEqual("ResourceNotFound");
      const peer = yield* kr
        .GetBgpPeer({ resourceUri: clusterId, bgpPeerName: "absent" })
        .pipe(Effect.flip);
      expect(peer._tag).toEqual("ResourceNotFound");

      // Deleting something that is not there succeeds.
      yield* kr.DeleteService({
        resourceUri: clusterId,
        serviceName: "storageclass",
      });
      yield* kr.DeleteStorageClass({
        resourceUri: clusterId,
        storageClassName: "absent",
      });

      // The connected cluster goes with the resource group.
      yield* stack.destroy();
      expect(
        yield* waitGone(
          hk.GetConnectedCluster({
            subscriptionId,
            resourceGroupName: group.resourceGroupName,
            clusterName: "stub",
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
