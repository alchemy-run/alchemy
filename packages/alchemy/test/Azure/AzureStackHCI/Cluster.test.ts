import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hci from "@distilled.cloud/azure/azurestackhci";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCluster = (resourceGroupName: string, clusterName: string) =>
  Effect.gen(function* () {
    return yield* hci.GetCluster({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
    });
  });

const program = (props: {
  kind?: string;
  tags: Record<string, string>;
  diagnosticLevel?: "Off" | "Basic" | "Enhanced";
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const cluster = yield* Azure.AzureStackHCI.Cluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      kind: props.kind,
      tags: props.tags,
      desiredProperties:
        props.diagnosticLevel === undefined
          ? undefined
          : { diagnosticLevel: props.diagnosticLevel },
    });
    return { group, cluster };
  });

// A cluster record without hardware stays `NotYetRegistered` and is free;
// it provisions in seconds.
test.provider(
  "create, update, replace, and delete an Azure Local cluster record",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster } = yield* stack.deploy(
        program({ tags: { env: "a" } }),
      );
      const get = (name: string) => getCluster(group.resourceGroupName, name);
      expect(cluster.status).toEqual("NotYetRegistered");
      expect(cluster.cloudId).not.toEqual("");
      const observed = yield* get(cluster.clusterName);
      expect(observed.properties?.status).toEqual("NotYetRegistered");
      expect(observed.identity?.type).toEqual("SystemAssigned");
      expect(observed.tags?.env).toEqual("a");
      expect(observed.tags?.["alchemy::id"]).toEqual("Cluster");

      // In place: tags and diagnostic level.
      const updated = yield* stack.deploy(
        program({ tags: { env: "b" }, diagnosticLevel: "Enhanced" }),
      );
      expect(updated.cluster.clusterId).toEqual(cluster.clusterId);
      expect(updated.cluster.cloudId).toEqual(cluster.cloudId);
      expect(updated.cluster.tags).toEqual({ env: "b" });
      const reobserved = yield* get(cluster.clusterName);
      expect(reobserved.tags?.env).toEqual("b");
      expect(reobserved.properties?.desiredProperties?.diagnosticLevel).toEqual(
        "Enhanced",
      );

      // Replacement: the kind is immutable.
      const replaced = yield* stack.deploy(
        program({
          kind: "AzureLocal",
          tags: { env: "b" },
          diagnosticLevel: "Enhanced",
        }),
      );
      expect(replaced.cluster.clusterName).not.toEqual(cluster.clusterName);
      const replacedObserved = yield* get(replaced.cluster.clusterName);
      expect(replacedObserved.kind).toEqual("AzureLocal");
      expect(yield* waitGone(get(cluster.clusterName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.cluster.clusterName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
