import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sf from "@distilled.cloud/azure/servicefabricmanagedclusters";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { withPublicIps } from "../gates.ts";
import { clusterAuth, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCluster = (resourceGroupName: string, clusterName: string) =>
  Effect.gen(function* () {
    return yield* sf.GetManagedCluster({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
    });
  });

const program = (props: {
  tags: Record<string, string>;
  addonFeatures?: Azure.ServiceFabric.ManagedClusterAddOnFeature[];
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "westus2",
    });
    const cluster = yield* Azure.ServiceFabric.ManagedCluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      ...clusterAuth,
      addonFeatures: props.addonFeatures,
      tags: props.tags,
    });
    return { group, cluster };
  });

// A Basic cluster without node types: no VMs, no cluster fee; only the
// managed load balancer and one public IP (~$0.01 per run). Provisions in
// ~5-10 minutes and stays in `WaitingForNodes`.
test.provider(
  "create, update, and delete a managed cluster",
  (stack) =>
    withPublicIps(1)(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { group, cluster } = yield* stack.deploy(
          program({ tags: { env: "test" } }),
        );
        expect(cluster.sku).toEqual("Basic");
        expect(cluster.dnsName).toEqual(cluster.managedClusterName);
        expect(cluster.tags).toEqual({ env: "test" });
        const observed = yield* getCluster(
          group.resourceGroupName,
          cluster.managedClusterName,
        );
        expect(observed.properties?.provisioningState).toEqual("Succeeded");
        expect(observed.properties?.adminUserName).toEqual("sfadmin");
        expect(
          observed.properties?.clients?.[0]?.thumbprint?.toUpperCase(),
        ).toEqual(clusterAuth.clients[0]!.thumbprint);
        expect(observed.tags?.env).toEqual("test");

        // In-place: tags and add-on features.
        const updated = yield* stack.deploy(
          program({ tags: { env: "prod" }, addonFeatures: ["DnsService"] }),
        );
        expect(updated.cluster.managedClusterId).toEqual(
          cluster.managedClusterId,
        );
        expect(updated.cluster.tags).toEqual({ env: "prod" });
        const reobserved = yield* getCluster(
          group.resourceGroupName,
          cluster.managedClusterName,
        );
        expect(reobserved.tags?.env).toEqual("prod");
        expect(reobserved.properties?.addonFeatures).toContain("DnsService");

        yield* stack.destroy();
        expect(
          yield* waitGone(
            getCluster(group.resourceGroupName, cluster.managedClusterName),
          ),
        ).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 900_000 },
);
