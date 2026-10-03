import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as signalr from "@distilled.cloud/azure/signalr";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getLink = (
  resourceGroupName: string,
  resourceName: string,
  replicaName: string,
  sharedPrivateLinkResourceName: string,
) =>
  Effect.gen(function* () {
    return yield* signalr.GetSignalRReplicaSharedPrivateLinkResource({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceName,
      replicaName,
      sharedPrivateLinkResourceName,
    });
  });

const program = (props: { target: "A" | "B"; requestMessage: string }) =>
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
    // Both vaults stay deployed across the replacement step.
    const vaultA = yield* Azure.KeyVault.Vault("VaultA", {
      resourceGroup: group.resourceGroupName,
      location: "westus2",
      softDeleteRetentionInDays: 7,
    });
    const vaultB = yield* Azure.KeyVault.Vault("VaultB", {
      resourceGroup: group.resourceGroupName,
      location: "westus2",
      softDeleteRetentionInDays: 7,
    });
    const target = props.target === "A" ? vaultA : vaultB;
    // Replica links are copies of the primary's links.
    const primaryLink = yield* Azure.SignalR.SharedPrivateLinkResource(
      "VaultLink",
      {
        resourceGroup: group.resourceGroupName,
        signalR: service.signalRName,
        groupId: "vault",
        privateLinkResourceId: target.vaultId,
        requestMessage: props.requestMessage,
      },
    );
    // Primary links replicate to replicas created after them.
    const replica = yield* Azure.SignalR.Replica("West", {
      resourceGroup: group.resourceGroupName,
      signalR: Output.all(
        service.signalRName,
        primaryLink.sharedPrivateLinkResourceId,
      ).pipe(Output.map(([name]) => name)),
      location: "westus2",
    });
    const link = yield* Azure.SignalR.ReplicaSharedPrivateLinkResource(
      "WestLink",
      {
        resourceGroup: group.resourceGroupName,
        signalR: service.signalRName,
        replica: replica.replicaName,
        sharedPrivateLinkResource: primaryLink.sharedPrivateLinkResourceName,
        groupId: "vault",
        privateLinkResourceId: target.vaultId,
      },
    );
    return { group, service, replica, target, link };
  });

// Premium_P1 primary + replica (~$0.08/hour per unit) and two vaults:
// ~$0.05 per run, but >15 minutes: on the test subscription the primary's
// link (status `Pending`) was never replicated to the replica within 10
// minutes, and a direct PUT on the replica fails with the typed
// `SignalRReplicaLinkNotReplicated`. Runs only with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "track, replace, and forget a replica shared private link resource",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service, replica, target, link } = yield* stack.deploy(
        program({ target: "A", requestMessage: "first" }),
      );
      const get = (name: string) =>
        getLink(
          group.resourceGroupName,
          service.signalRName,
          replica.replicaName,
          name,
        );
      const observed = yield* get(link.sharedPrivateLinkResourceName);
      expect(observed.properties?.groupId).toEqual("vault");
      expect(observed.properties?.privateLinkResourceId?.toLowerCase()).toEqual(
        target.vaultId.toLowerCase(),
      );
      expect(observed.properties?.requestMessage).toEqual("first");
      expect(link.status).toBeDefined();

      // Replacement: a new primary link (new target) yields a new copy.
      const replaced = yield* stack.deploy(
        program({ target: "B", requestMessage: "second" }),
      );
      expect(replaced.link.sharedPrivateLinkResourceName).not.toEqual(
        link.sharedPrivateLinkResourceName,
      );
      const replacedObserved = yield* get(
        replaced.link.sharedPrivateLinkResourceName,
      );
      expect(
        replacedObserved.properties?.privateLinkResourceId?.toLowerCase(),
      ).toEqual(replaced.target.vaultId.toLowerCase());

      // The old primary link is gone, and so is its copy.
      expect(yield* waitGone(get(link.sharedPrivateLinkResourceName))).toEqual(
        "gone",
      );

      // Replica links have no DELETE; they go away with the replica.
      yield* stack.destroy();
      expect(
        yield* waitGone(
          signalr.GetSignalRReplicas({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            resourceName: service.signalRName,
            replicaName: replica.replicaName,
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
