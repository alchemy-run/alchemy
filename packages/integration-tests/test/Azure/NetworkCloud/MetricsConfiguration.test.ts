import * as Azure from "@alchemy.run/azure";
import * as nc from "@distilled.cloud/azure/networkcloud";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  bogusCustomLocation,
  customLocationId,
  logLevel,
  nexusCluster,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const get = Effect.gen(function* () {
  return yield* nc.GetMetricsConfiguration({
    subscriptionId: yield* subscription,
    resourceGroupName: nexusCluster.resourceGroup,
    clusterName: nexusCluster.name,
    metricsConfigurationName: "default",
  });
});

const program = (props: { collectionInterval: number; env: string }) =>
  Effect.gen(function* () {
    const res = yield* Azure.NetworkCloud.MetricsConfiguration("Metrics", {
      // The configuration lives in the resource group of its cluster.
      resourceGroup: nexusCluster.resourceGroup,
      clusterName: nexusCluster.name,
      location: "eastus",
      customLocationId,
      collectionInterval: props.collectionInterval,
      tags: { env: props.env },
    });
    return { res };
  });

// Billed as part of the Nexus cluster; a few minutes once the cluster
// exists. Needs a deployed Operator Nexus cluster on certified on-premises
// racks (AZURE_NEXUS_CLUSTER_ID, AZURE_NEXUS_CUSTOM_LOCATION_ID). A cluster
// has one `default` configuration, so there is no replacement step.
test.provider.skipIf(!runPaidOnly || !customLocationId || !nexusCluster.name)(
  "create, update, and delete a Nexus metrics configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { res } = yield* stack.deploy(program({ collectionInterval: 300, env: "a" }));
      expect(res.metricsConfigurationName).toEqual("default");
      const observed = yield* get;
      expect(observed.properties.collectionInterval).toEqual(300);
      expect(observed.tags?.env).toEqual("a");

      // In place.
      const updated = yield* stack.deploy(program({ collectionInterval: 600, env: "b" }));
      expect(updated.res.metricsConfigurationId).toEqual(res.metricsConfigurationId);
      const reobserved = yield* get;
      expect(reobserved.properties.collectionInterval).toEqual(600);
      expect(reobserved.tags?.env).toEqual("b");

      yield* stack.destroy();
      expect(yield* waitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);

// Ungated probe: the trial has no Operator Nexus cluster, so the RP rejects
// a PUT against a custom location that does not exist. Only a resource group
// is created ($0, ~1 minute).
test.provider(
  "the trial rejects a Nexus metrics configuration without a cluster custom location",
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
      const error = yield* nc
        .MetricsConfigurationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName,
          location: "eastus",
          clusterName: "nocluster",
          metricsConfigurationName: "default",
          extendedLocation: bogusCustomLocation(subscriptionId, resourceGroupName),
          properties: { collectionInterval: 300 },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");
      expect(error.message).toContain("custom location was not found");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
