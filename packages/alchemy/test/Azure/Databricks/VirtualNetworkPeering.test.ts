import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as databricks from "@distilled.cloud/azure/databricks";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, subscription, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPeering = (
  resourceGroupName: string,
  workspaceName: string,
  peeringName: string,
) =>
  Effect.gen(function* () {
    return yield* databricks.GetVNetPeering({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      peeringName,
    });
  });

/** Poll an out-of-band GET until it reports a typed not-found. */
const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 30,
    }),
  );

const program = (props: {
  remote: "A" | "B";
  allowForwardedTraffic: boolean;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const workspace = yield* Azure.Databricks.Workspace("Workspace", {
      resourceGroup: group.resourceGroupName,
      sku: "premium",
      enableNoPublicIp: false,
      forceDeletion: true,
    });
    // Both remote VNets stay deployed across the replacement step.
    const hubA = yield* Azure.Network.VirtualNetwork("HubA", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.40.0.0/16"],
    });
    const hubB = yield* Azure.Network.VirtualNetwork("HubB", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.41.0.0/16"],
    });
    const hub = props.remote === "A" ? hubA : hubB;
    const peering = yield* Azure.Databricks.VirtualNetworkPeering("ToHub", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      remoteVirtualNetworkId: hub.virtualNetworkId,
      allowForwardedTraffic: props.allowForwardedTraffic,
    });
    const reverse = yield* Azure.Network.VirtualNetworkPeering("HubToDbx", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: hub.virtualNetworkName,
      remoteVirtualNetworkId: peering.databricksVirtualNetworkId,
    });
    return { group, workspace, hubA, hubB, peering, reverse };
  });

// Premium Hybrid workspace with no clusters plus two empty VNets: cents.
// ~3 minutes to create the workspace, ~3.5 to delete it.
test.provider(
  "create, update, replace, and delete a Databricks VNet peering",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, hubA, peering } = yield* stack.deploy(
        program({ remote: "A", allowForwardedTraffic: false }),
      );
      const rg = group.resourceGroupName;
      const get = (name: string) =>
        getPeering(rg, workspace.workspaceName, name);
      expect(peering.remoteVirtualNetworkId.toLowerCase()).toEqual(
        hubA.virtualNetworkId.toLowerCase(),
      );
      expect(peering.databricksVirtualNetworkId.toLowerCase()).toContain(
        workspace.managedResourceGroupId!.toLowerCase(),
      );
      // Connected once the reverse peering exists.
      const connected = yield* get(peering.peeringName).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (p) => p.properties.peeringState === "Connected",
          times: 24,
        }),
      );
      expect(connected.properties.peeringState).toEqual("Connected");
      expect(connected.properties.allowForwardedTraffic).toEqual(false);

      // In place: allow forwarded traffic.
      const updated = yield* stack.deploy(
        program({ remote: "A", allowForwardedTraffic: true }),
      );
      expect(updated.peering.peeringId).toEqual(peering.peeringId);
      const reobserved = yield* get(peering.peeringName);
      expect(reobserved.properties.allowForwardedTraffic).toEqual(true);

      // Replacement: a different remote VNet.
      const replaced = yield* stack.deploy(
        program({ remote: "B", allowForwardedTraffic: true }),
      );
      expect(replaced.peering.peeringName).not.toEqual(peering.peeringName);
      const replacedObserved = yield* get(replaced.peering.peeringName);
      expect(
        replacedObserved.properties.remoteVirtualNetwork.id?.toLowerCase(),
      ).toEqual(replaced.hubB.virtualNetworkId.toLowerCase());
      expect(yield* waitGone(get(peering.peeringName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.peering.peeringName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
