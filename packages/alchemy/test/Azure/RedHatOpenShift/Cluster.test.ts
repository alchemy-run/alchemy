import * as Azure from "@/Azure";
import type { Input } from "@/Input";
import * as Test from "@/Test/Alchemy";
import * as aro from "@distilled.cloud/azure/redhatopenshift";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const tags = ["provider:azure", "provider:azure:redhatopenshift", "live"];

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const location = "westus3";

/** Network Contributor. */
const NETWORK_CONTRIBUTOR = "4d97b98b-1d4f-4787-a291-c67834d212e7";

const getCluster = (resourceGroupName: string, resourceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* aro.GetOpenShiftCluster({
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

const network = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", { location });
  const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
    resourceGroup: group.resourceGroupName,
    location,
    addressPrefixes: ["10.0.0.0/22"],
  });
  const master = yield* Azure.Network.Subnet("Master", {
    resourceGroup: group.resourceGroupName,
    virtualNetwork: vnet.virtualNetworkName,
    addressPrefix: "10.0.0.0/23",
  });
  const worker = yield* Azure.Network.Subnet("Worker", {
    resourceGroup: group.resourceGroupName,
    virtualNetwork: vnet.virtualNetworkName,
    addressPrefix: "10.0.2.0/23",
  });
  return { group, vnet, master, worker };
});

const program = (props: {
  clientId: string;
  clientSecret: Redacted.Redacted<string>;
  pullSecret?: Redacted.Redacted<string>;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, vnet, master, worker } = yield* network;
    const cluster = yield* Azure.RedHatOpenShift.Cluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      location,
      servicePrincipal: {
        clientId: props.clientId,
        clientSecret: props.clientSecret,
      },
      pullSecret: props.pullSecret,
      master: { subnetId: master.subnetId },
      worker: { subnetId: worker.subnetId },
      tags: props.tags,
    });
    return { group, vnet, cluster };
  });

/**
 * Role assignments ARO needs on the virtual network: the cluster's service
 * principal and the tenant's Azure Red Hat OpenShift RP service principal
 * both need Network Contributor.
 */
const vnetRoles = (
  vnetId: Input<string>,
  clusterPrincipalId: string,
  rpPrincipalId: string,
) =>
  Effect.gen(function* () {
    yield* Azure.Authorization.RoleAssignment("ClusterSpNetwork", {
      scope: vnetId,
      roleDefinitionId: NETWORK_CONTRIBUTOR,
      principalId: clusterPrincipalId,
      principalType: "ServicePrincipal",
    });
    yield* Azure.Authorization.RoleAssignment("RpSpNetwork", {
      scope: vnetId,
      roleDefinitionId: NETWORK_CONTRIBUTOR,
      principalId: rpPrincipalId,
      principalType: "ServicePrincipal",
    });
  });

// The smallest cluster is 3 × Standard_D8s_v5 control plane + 3 ×
// Standard_D4s_v5 workers = 36 vCPUs (44 required with the bootstrap node),
// ~$2-3/hour, 35-45 minutes to create and 20-30 to delete. The free trial
// has ~4 regional vCPUs, so this only runs with AZURE_TEST_PAID=1 on a paid
// subscription with ARO quota, plus:
//   ARO_CLIENT_ID / ARO_CLIENT_SECRET / ARO_CLIENT_OBJECT_ID — cluster SP
//   ARO_RP_OBJECT_ID — object ID of the "Azure Red Hat OpenShift" RP SP
//   ARO_PULL_SECRET (optional) — Red Hat pull secret
// Expect ~1.5 hours of wall clock; raise the timeout there.
test.provider.skipIf(!runPaidOnly)(
  "create, update tags, and delete an OpenShift cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const clientId = process.env.ARO_CLIENT_ID!;
      const clientSecret = Redacted.make(process.env.ARO_CLIENT_SECRET!);
      const pullSecret = process.env.ARO_PULL_SECRET
        ? Redacted.make(process.env.ARO_PULL_SECRET)
        : undefined;
      const withRoles = (props: { tags: Record<string, string> }) =>
        Effect.gen(function* () {
          const out = yield* program({
            clientId,
            clientSecret,
            pullSecret,
            ...props,
          });
          yield* vnetRoles(
            out.vnet.virtualNetworkId,
            process.env.ARO_CLIENT_OBJECT_ID!,
            process.env.ARO_RP_OBJECT_ID!,
          );
          return out;
        });

      const { group, cluster } = yield* stack.deploy(
        withRoles({ tags: { env: "test" } }),
      );
      expect(cluster.provisioningState).toEqual("Succeeded");
      expect(cluster.consoleUrl).toContain("console-openshift-console");
      expect(cluster.apiServerUrl).toContain(":6443");
      expect(cluster.kubeadminUsername).toEqual("kubeadmin");
      expect(cluster.kubeadminPassword).toBeDefined();
      expect(cluster.kubeconfig).toBeDefined();
      const observed = yield* getCluster(
        group.resourceGroupName,
        cluster.clusterName,
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.properties?.workerProfiles?.[0]?.count).toEqual(3);

      // In place: tags.
      const updated = yield* stack.deploy(withRoles({ tags: { env: "prod" } }));
      expect(updated.cluster.clusterId).toEqual(cluster.clusterId);
      const reobserved = yield* getCluster(
        group.resourceGroupName,
        cluster.clusterName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* clusterGone(group.resourceGroupName, cluster.clusterName),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (resource group + VNet + 2 subnets, free, ~2 minutes): the
// ARO RP validates VM sizes synchronously on PUT, before quota and the
// service principal, and the free trial is not offered Standard_D8s_v5 in
// any region, so the cluster is rejected with a typed error and nothing is
// provisioned.
test.provider(
  "the free trial rejects cluster creation with a typed SKU restriction",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(network);
      const error = yield* stack
        .deploy(
          program({
            clientId: "00000000-0000-0000-0000-000000000001",
            clientSecret: Redacted.make("not-a-real-secret"),
            tags: {},
          }),
        )
        .pipe(Effect.flip);
      expect(JSON.stringify(error)).toContain(
        '"_tag":"RedHatOpenShiftVmSkuRestricted"',
      );

      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const listed = yield* aro.ListOpenShiftClusterByResourceGroup({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
      });
      expect(listed.value ?? []).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
