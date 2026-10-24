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

/** An optional Nexus Kubernetes feature (not installed by default). */
const FEATURE = "azureMonitorAgent";

const get = (resourceGroupName: string, kubernetesClusterName: string) =>
  Effect.gen(function* () {
    return yield* nc.GetKubernetesClusterFeature({
      subscriptionId: yield* subscription,
      resourceGroupName,
      kubernetesClusterName,
      featureName: FEATURE,
    });
  });

const program = (props: { env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const { csn, l3 } = yield* workloadNetworks(group.resourceGroupName, 1023);
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
    const res = yield* Azure.NetworkCloud.KubernetesClusterFeature("Monitor", {
      resourceGroup: group.resourceGroupName,
      kubernetesClusterName: naks.kubernetesClusterName,
      name: FEATURE,
      location: "eastus",
      tags: { env: props.env },
    });
    return { group, naks, res };
  });

// Billed as part of the Nexus cluster; 30-60 min (mostly the Kubernetes
// cluster). Needs a deployed Operator Nexus cluster on certified
// on-premises racks (AZURE_NEXUS_CUSTOM_LOCATION_ID,
// AZURE_NEXUS_L3_ISOLATION_DOMAIN_ID, AZURE_NEXUS_KUBERNETES_VERSION). The
// feature name is its identity and each name exists once per cluster, so
// there is no create-before-delete replacement step.
test.provider.skipIf(!runPaidOnly || !hasWorkloadNetworks || !nexus.kubernetesVersion)(
  "create, update, and delete a Nexus Kubernetes cluster feature",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, naks, res } = yield* stack.deploy(program({ env: "a" }));
      const rg = group.resourceGroupName;
      const cluster = naks.kubernetesClusterName;
      expect(res.featureName).toEqual(FEATURE);
      const observed = yield* get(rg, cluster);
      expect(observed.tags?.env).toEqual("a");

      // In place.
      const updated = yield* stack.deploy(program({ env: "b" }));
      expect(updated.res.featureId).toEqual(res.featureId);
      const reobserved = yield* get(rg, cluster);
      expect(reobserved.tags?.env).toEqual("b");

      yield* stack.destroy();
      expect(yield* waitGone(get(rg, cluster))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 7_200_000 },
);

// Ungated probe: the trial has no Nexus Kubernetes cluster, so ARM rejects
// a feature under a cluster that does not exist. Only a resource group is
// created ($0, ~1 minute). ARM reports code `ParentResourceNotFound`,
// which distilled maps to `ResourceNotFound`.
test.provider(
  "the trial rejects a Nexus Kubernetes cluster feature without a Kubernetes cluster",
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
        .KubernetesClusterFeaturesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          location: "eastus",
          kubernetesClusterName: "nonaks",
          featureName: FEATURE,
          properties: {},
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
