import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as signalr from "@distilled.cloud/azure/signalr";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getReplica = (
  resourceGroupName: string,
  resourceName: string,
  replicaName: string,
) =>
  Effect.gen(function* () {
    return yield* signalr.GetSignalRReplicas({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceName,
      replicaName,
    });
  });

const program = (props: {
  location: string;
  regionEndpointEnabled: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Replicas need a Premium service.
    const service = yield* Azure.SignalR.SignalR("Realtime", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      sku: "Premium_P1",
    });
    const replica = yield* Azure.SignalR.Replica("West", {
      resourceGroup: group.resourceGroupName,
      signalR: service.signalRName,
      location: props.location,
      regionEndpointEnabled: props.regionEndpointEnabled,
      tags: props.tags,
    });
    return { group, service, replica };
  });

// Premium_P1 primary + replica (~$0.08/hour per unit, up to three units
// during replacement): ~$0.05 per run, ~8-9 minutes.
test.provider(
  "create, update, replace, and delete a SignalR replica",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service, replica } = yield* stack.deploy(
        program({
          location: "westus2",
          regionEndpointEnabled: true,
          tags: { env: "test" },
        }),
      );
      const get = (name: string) =>
        getReplica(group.resourceGroupName, service.signalRName, name);
      expect(replica.sku).toEqual("Premium_P1");
      const observed = yield* get(replica.replicaName);
      expect(observed.location.replace(/\s/g, "").toLowerCase()).toEqual(
        "westus2",
      );
      expect(observed.tags?.env).toEqual("test");

      // In place: drain the regional endpoint and retag.
      const updated = yield* stack.deploy(
        program({
          location: "westus2",
          regionEndpointEnabled: false,
          tags: { env: "prod" },
        }),
      );
      expect(updated.replica.replicaId).toEqual(replica.replicaId);
      expect(updated.replica.regionEndpointEnabled).toEqual(false);
      const reobserved = yield* get(replica.replicaName);
      expect(reobserved.properties?.regionEndpointEnabled).toEqual("Disabled");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the location is immutable.
      const replaced = yield* stack.deploy(
        program({
          location: "westus3",
          regionEndpointEnabled: true,
          tags: { env: "prod" },
        }),
      );
      expect(replaced.replica.replicaName).not.toEqual(replica.replicaName);
      const replacedObserved = yield* get(replaced.replica.replicaName);
      expect(
        replacedObserved.location.replace(/\s/g, "").toLowerCase(),
      ).toEqual("westus3");
      expect(yield* waitGone(get(replica.replicaName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.replica.replicaName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
