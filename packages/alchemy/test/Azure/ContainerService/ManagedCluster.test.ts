import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cs from "@distilled.cloud/azure/containerservice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runExpensive, withPublicIps, withVcpus } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getCluster = (resourceGroupName: string, resourceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* cs.GetManagedCluster({
      subscriptionId,
      resourceGroupName,
      resourceName,
    });
  });

const clusterGone = (resourceGroupName: string, resourceName: string) =>
  getCluster(resourceGroupName, resourceName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: {
  dnsPrefix?: string;
  oidcIssuerEnabled: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "westus3",
    });
    const cluster = yield* Azure.ContainerService.ManagedCluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      location: "westus3",
      dnsPrefix: props.dnsPrefix,
      defaultNodePool: { vmSize: "Standard_D2s_v7", count: 1 },
      oidcIssuerEnabled: props.oidcIssuerEnabled,
      tags: props.tags,
    });
    return { group, cluster };
  });

// One Standard_D2s_v7 node (~$0.10/h) on the Free tier: ~6 min create, ~2 min
// update, ~5 min delete — a few cents per run.
test.provider(
  "create, update, and delete a managed cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ oidcIssuerEnabled: false, tags: { env: "test" } }),
      );
      const { group, cluster } = created;
      expect(cluster.fqdn).toContain("azmk8s.io");
      expect(cluster.skuTier).toEqual("Free");
      expect(cluster.kubeletIdentity.objectId).toBeTruthy();
      expect(cluster.principalId).toBeTruthy();
      expect(cluster.oidcIssuerUrl).toBeUndefined();
      const observed = yield* getCluster(
        group.resourceGroupName,
        cluster.clusterName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.agentPoolProfiles?.[0]?.vmSize).toEqual(
        "Standard_D2s_v7",
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Cluster");

      const updated = yield* stack.deploy(
        program({ oidcIssuerEnabled: true, tags: { env: "prod" } }),
      );
      expect(updated.cluster.clusterName).toEqual(cluster.clusterName);
      expect(updated.cluster.oidcIssuerUrl).toContain("https://");
      expect(updated.cluster.tags).toEqual({ env: "prod" });
      const reobserved = yield* getCluster(
        group.resourceGroupName,
        cluster.clusterName,
      );
      expect(reobserved.properties?.oidcIssuerProfile?.enabled).toEqual(true);
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.properties?.agentPoolProfiles?.length).toEqual(1);

      yield* stack.destroy();
      expect(
        yield* clusterGone(group.resourceGroupName, cluster.clusterName),
      ).toEqual("gone");
    }).pipe(withPublicIps(1), withVcpus(2), logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerservice", "live"],
    timeout: 900_000,
  },
);

// Replacement provisions a second cluster before deleting the first
// (~2 × 6 min, 4 vCPUs at once): over the time budget, run explicitly.
test.provider.skipIf(!runExpensive)(
  "changing dnsPrefix replaces the cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        program({
          dnsPrefix: "alchemyaks1",
          oidcIssuerEnabled: false,
          tags: {},
        }),
      );
      const replaced = yield* stack.deploy(
        program({
          dnsPrefix: "alchemyaks2",
          oidcIssuerEnabled: false,
          tags: {},
        }),
      );
      expect(replaced.cluster.dnsPrefix).toEqual("alchemyaks2");
      expect(replaced.cluster.clusterId).not.toEqual(created.cluster.clusterId);
      yield* stack.destroy();
      expect(
        yield* clusterGone(
          created.group.resourceGroupName,
          replaced.cluster.clusterName,
        ),
      ).toEqual("gone");
    }).pipe(withPublicIps(2), withVcpus(4), logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerservice", "live"],
    timeout: 900_000,
  },
);
