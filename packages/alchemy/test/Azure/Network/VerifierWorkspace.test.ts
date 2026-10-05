import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  subscriptionId,
  tags,
  untilGone,
  withNetworkManager,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getWorkspace = (
  resourceGroupName: string,
  networkManagerName: string,
  workspaceName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetVerifierWorkspace({
      subscriptionId,
      resourceGroupName,
      networkManagerName,
      workspaceName,
    }),
  );
const getIntent = (
  resourceGroupName: string,
  networkManagerName: string,
  workspaceName: string,
  reachabilityAnalysisIntentName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetReachabilityAnalysisIntent({
      subscriptionId,
      resourceGroupName,
      networkManagerName,
      workspaceName,
      reachabilityAnalysisIntentName,
    }),
  );

// Verifier workspaces and intents are free (analysis runs are not started).
const program = (props: { description: string; port: string; env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const manager = yield* Azure.Network.NetworkManager("Manager", {
      resourceGroup: group.resourceGroupName,
      scopeAccesses: [],
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const web = yield* Azure.Network.Subnet("Web", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
    });
    const db = yield* Azure.Network.Subnet("Db", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.2.0/24",
    });
    const workspace = yield* Azure.Network.VerifierWorkspace("Verify", {
      resourceGroup: group.resourceGroupName,
      networkManager: manager.networkManagerName,
      description: props.description,
      tags: { env: props.env },
    });
    const intent = yield* Azure.Network.ReachabilityAnalysisIntent("WebToDb", {
      resourceGroup: group.resourceGroupName,
      networkManager: manager.networkManagerName,
      verifierWorkspace: workspace.workspaceName,
      sourceResourceId: web.subnetId,
      destinationResourceId: db.subnetId,
      ipTraffic: {
        sourceIps: ["10.0.1.0/24"],
        destinationIps: ["10.0.2.0/24"],
        sourcePorts: ["*"],
        destinationPorts: [props.port],
        protocols: ["TCP"],
      },
    });
    return { group, manager, workspace, intent };
  });

test.provider(
  "create, update, and delete a verifier workspace (with an intent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, manager, workspace, intent } = yield* stack.deploy(
        program({ description: "one", port: "5432", env: "test" }),
      );
      expect(intent.ipTraffic?.destinationPorts).toEqual(["5432"]);
      const observed = yield* getWorkspace(
        group.resourceGroupName,
        manager.networkManagerName,
        workspace.workspaceName,
      );
      expect(observed.properties?.description).toEqual("one");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(
        program({ description: "two", port: "443", env: "prod" }),
      );
      expect(updated.workspace.workspaceId).toEqual(workspace.workspaceId);
      const reobserved = yield* getWorkspace(
        group.resourceGroupName,
        manager.networkManagerName,
        workspace.workspaceName,
      );
      expect(reobserved.properties?.description).toEqual("two");
      expect(reobserved.tags?.env).toEqual("prod");
      // Intents are immutable: a new intent replaces the old one.
      expect(updated.intent.intentName).not.toEqual(intent.intentName);
      const observedIntent = yield* getIntent(
        group.resourceGroupName,
        manager.networkManagerName,
        workspace.workspaceName,
        updated.intent.intentName,
      );
      expect(observedIntent.properties.ipTraffic.destinationPorts).toEqual([
        "443",
      ]);
      expect(
        yield* untilGone(
          getIntent(
            group.resourceGroupName,
            manager.networkManagerName,
            workspace.workspaceName,
            intent.intentName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getWorkspace(
            group.resourceGroupName,
            manager.networkManagerName,
            workspace.workspaceName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withNetworkManager, logLevel),
  { tags, timeout: 600_000 },
);
