import * as Azure from "@alchemy.run/azure";
import * as nc from "@distilled.cloud/azure/networkcloud";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  bogusCustomLocation,
  customLocationId,
  hasWorkloadNetworks,
  logLevel,
  nexus,
  sshKey,
  subscription,
  tags,
  waitGone,
  workloadNetworks,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const get = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    return yield* nc.GetKubernetesCluster({
      subscriptionId: yield* subscription,
      resourceGroupName,
      kubernetesClusterName: name,
    });
  });

const program = (props: { env: string; poolLabel: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const { csn, l3 } = yield* workloadNetworks(group.resourceGroupName, 1021);
    const res = yield* Azure.NetworkCloud.KubernetesCluster("Naks", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      customLocationId,
      kubernetesVersion: nexus.kubernetesVersion,
      controlPlaneNodeConfiguration: { count: 1, vmSkuName: "NC_G6_28_v1" },
      initialAgentPoolConfigurations: [
        {
          name: "system",
          count: 1,
          mode: "System",
          vmSkuName: "NC_P10_56_v1",
          labels: [{ key: "pool", value: props.poolLabel }],
        },
      ],
      networkConfiguration: {
        cloudServicesNetworkId: csn.cloudServicesNetworkId,
        cniNetworkId: l3.l3NetworkId,
      },
      administratorConfiguration: {
        adminUsername: "azureuser",
        sshPublicKeys: [sshKey],
      },
      tags: { env: props.env },
    });
    return { group, res };
  });

// Billed as part of the Nexus cluster; 30-60 min per Kubernetes cluster
// (the replacement step builds a second one). Needs a deployed Operator
// Nexus cluster on certified on-premises racks
// (AZURE_NEXUS_CUSTOM_LOCATION_ID, AZURE_NEXUS_L3_ISOLATION_DOMAIN_ID,
// AZURE_NEXUS_KUBERNETES_VERSION).
test.provider.skipIf(!runPaidOnly || !hasWorkloadNetworks || !nexus.kubernetesVersion)(
  "create, update, replace, and delete a Nexus Kubernetes cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(program({ env: "a", poolLabel: "a" }));
      const observed = yield* get(group.resourceGroupName, res.kubernetesClusterName);
      expect(observed.properties.kubernetesVersion).toEqual(nexus.kubernetesVersion);
      expect(observed.properties.initialAgentPoolConfigurations[0]?.labels?.[0]?.value).toEqual(
        "a",
      );
      expect(observed.tags?.env).toEqual("a");

      // In place.
      const updated = yield* stack.deploy(program({ env: "b", poolLabel: "a" }));
      expect(updated.res.kubernetesClusterId).toEqual(res.kubernetesClusterId);
      const reobserved = yield* get(group.resourceGroupName, res.kubernetesClusterName);
      expect(reobserved.tags?.env).toEqual("b");

      // Replacement (initial agent pools are immutable).
      const replaced = yield* stack.deploy(program({ env: "b", poolLabel: "b" }));
      expect(replaced.res.kubernetesClusterName).not.toEqual(res.kubernetesClusterName);
      expect(yield* waitGone(get(group.resourceGroupName, res.kubernetesClusterName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(get(group.resourceGroupName, replaced.res.kubernetesClusterName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 10_800_000 },
);

// Ungated probe: the trial has no Operator Nexus cluster, so the RP rejects
// a PUT against a custom location that does not exist. Only a resource group
// is created ($0, ~1 minute).
test.provider(
  "the trial rejects a Nexus Kubernetes cluster without a cluster custom location",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      const resourceGroupName = group.resourceGroupName;
      const pre = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers`;
      const error = yield* nc
        .KubernetesClustersCreateOrUpdate({
          subscriptionId,
          resourceGroupName,
          location: "eastus",
          kubernetesClusterName: "probe",
          extendedLocation: bogusCustomLocation(subscriptionId, resourceGroupName),
          properties: {
            kubernetesVersion: "1.30.4-1",
            controlPlaneNodeConfiguration: { count: 1, vmSkuName: "NC_G6_28_v1" },
            initialAgentPoolConfigurations: [
              { name: "system", count: 1, mode: "System", vmSkuName: "NC_P10_56_v1" },
            ],
            networkConfiguration: {
              cloudServicesNetworkId: `${pre}/Microsoft.NetworkCloud/cloudServicesNetworks/nocsn`,
              cniNetworkId: `${pre}/Microsoft.NetworkCloud/l3Networks/nol3`,
            },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");
      expect(error.message).toContain("custom location was not found");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
