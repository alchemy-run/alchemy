import * as Azure from "@alchemy.run/azure";
import * as nc from "@distilled.cloud/azure/networkcloud";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
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

const get = (resourceGroupName: string, kubernetesClusterName: string, name: string) =>
  Effect.gen(function* () {
    return yield* nc.GetAgentPool({
      subscriptionId: yield* subscription,
      resourceGroupName,
      kubernetesClusterName,
      agentPoolName: name,
    });
  });

const program = (props: { count: number; label: string; env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const { csn, l3 } = yield* workloadNetworks(group.resourceGroupName, 1022);
    const naks = yield* Azure.NetworkCloud.KubernetesCluster("Naks", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      customLocationId,
      kubernetesVersion: nexus.kubernetesVersion,
      controlPlaneNodeConfiguration: { count: 1, vmSkuName: "NC_G6_28_v1" },
      initialAgentPoolConfigurations: [
        { name: "system", count: 1, mode: "System", vmSkuName: "NC_P10_56_v1" },
      ],
      networkConfiguration: {
        cloudServicesNetworkId: csn.cloudServicesNetworkId,
        cniNetworkId: l3.l3NetworkId,
      },
      administratorConfiguration: {
        adminUsername: "azureuser",
        sshPublicKeys: [sshKey],
      },
    });
    const res = yield* Azure.NetworkCloud.AgentPool("Workers", {
      resourceGroup: group.resourceGroupName,
      kubernetesClusterName: naks.kubernetesClusterName,
      location: "eastus",
      customLocationId,
      count: props.count,
      mode: "User",
      vmSkuName: "NC_P10_56_v1",
      labels: [{ key: "pool", value: props.label }],
      tags: { env: props.env },
    });
    return { group, naks, res };
  });

// Billed as part of the Nexus cluster; 60-90 min (a Kubernetes cluster plus
// the pool and its replacement). Needs a deployed Operator Nexus cluster on
// certified on-premises racks (AZURE_NEXUS_CUSTOM_LOCATION_ID,
// AZURE_NEXUS_L3_ISOLATION_DOMAIN_ID, AZURE_NEXUS_KUBERNETES_VERSION).
test.provider.skipIf(!runPaidOnly || !hasWorkloadNetworks || !nexus.kubernetesVersion)(
  "create, update, replace, and delete a Nexus agent pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, naks, res } = yield* stack.deploy(
        program({ count: 1, label: "a", env: "a" }),
      );
      const rg = group.resourceGroupName;
      const cluster = naks.kubernetesClusterName;
      const observed = yield* get(rg, cluster, res.agentPoolName);
      expect(observed.properties.count).toEqual(1);
      expect(observed.properties.mode).toEqual("User");
      expect(observed.tags?.env).toEqual("a");

      // In place.
      const updated = yield* stack.deploy(program({ count: 2, label: "a", env: "b" }));
      expect(updated.res.agentPoolId).toEqual(res.agentPoolId);
      const reobserved = yield* get(rg, cluster, res.agentPoolName);
      expect(reobserved.properties.count).toEqual(2);
      expect(reobserved.tags?.env).toEqual("b");

      // Replacement (labels are immutable).
      const replaced = yield* stack.deploy(program({ count: 2, label: "b", env: "b" }));
      expect(replaced.res.agentPoolName).not.toEqual(res.agentPoolName);
      expect(yield* waitGone(get(rg, cluster, res.agentPoolName))).toEqual("gone");
      const final = yield* get(rg, cluster, replaced.res.agentPoolName);
      expect(final.properties.labels?.[0]?.value).toEqual("b");

      yield* stack.destroy();
      expect(yield* waitGone(get(rg, cluster, replaced.res.agentPoolName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 10_800_000 },
);

// Ungated probe: the trial has no Nexus Kubernetes cluster, so ARM rejects
// an agent pool under a cluster that does not exist. Only a resource group
// is created ($0, ~1 minute). ARM reports code `ParentResourceNotFound`,
// which distilled maps to `ResourceNotFound`.
test.provider(
  "the trial rejects a Nexus agent pool without a Kubernetes cluster",
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
      const error = yield* nc
        .AgentPoolsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          location: "eastus",
          kubernetesClusterName: "nonaks",
          agentPoolName: "probe",
          properties: { count: 1, mode: "User", vmSkuName: "NC_P10_56_v1" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("ResourceNotFound");
      expect(error._tag === "ResourceNotFound" ? error.code : undefined).toEqual(
        "ParentResourceNotFound",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
