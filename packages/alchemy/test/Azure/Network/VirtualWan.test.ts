import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getWan = (resourceGroupName: string, VirtualWANName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetVirtualWan({ subscriptionId, resourceGroupName, VirtualWANName }),
  );

// The virtual WAN object is free and provisions in seconds.
const program = (props: {
  location: string;
  allowBranchToBranchTraffic: boolean;
  env: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const wan = yield* Azure.Network.VirtualWan("Wan", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      allowBranchToBranchTraffic: props.allowBranchToBranchTraffic,
      tags: { env: props.env },
    });
    return { group, wan };
  });

test.provider(
  "create, update, replace, and delete a virtual WAN",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, wan } = yield* stack.deploy(
        program({
          location: "eastus",
          allowBranchToBranchTraffic: true,
          env: "test",
        }),
      );
      expect(wan.type).toEqual("Standard");
      const observed = yield* getWan(group.resourceGroupName, wan.virtualWanName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.allowBranchToBranchTraffic).toEqual(true);
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(
        program({
          location: "eastus",
          allowBranchToBranchTraffic: false,
          env: "prod",
        }),
      );
      expect(updated.wan.virtualWanId).toEqual(wan.virtualWanId);
      const reobserved = yield* getWan(
        group.resourceGroupName,
        wan.virtualWanName,
      );
      expect(reobserved.properties?.allowBranchToBranchTraffic).toEqual(false);
      expect(reobserved.tags?.env).toEqual("prod");

      // A location change replaces the WAN.
      const replaced = yield* stack.deploy(
        program({
          location: "westus2",
          allowBranchToBranchTraffic: false,
          env: "prod",
        }),
      );
      expect(replaced.wan.location).toEqual("westus2");
      expect(
        yield* untilGone(getWan(group.resourceGroupName, wan.virtualWanName)),
      ).toEqual("gone");
      expect(replaced.wan.virtualWanName).not.toEqual(wan.virtualWanName);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getWan(group.resourceGroupName, replaced.wan.virtualWanName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
