import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as keyvault from "@distilled.cloud/azure/keyvault";
import * as signalr from "@distilled.cloud/azure/signalr";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
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

/**
 * Act as the vaults' owner: approve every pending private endpoint
 * connection on them, every 10 seconds, until interrupted (bounded).
 * Azure replicates a primary shared private link to replicas only once
 * the target has approved it.
 */
const approvePending = (resourceGroupName: string, vaultNames: string[]) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    for (const vaultName of vaultNames) {
      const connections =
        yield* keyvault.ListPrivateEndpointConnectionByResource({
          subscriptionId,
          resourceGroupName,
          vaultName,
        });
      for (const connection of connections.value ?? []) {
        if (
          connection.name !== undefined &&
          connection.properties?.privateLinkServiceConnectionState?.status ===
            "Pending"
        ) {
          yield* Effect.logInfo(
            `approving ${connection.name} on vault ${vaultName}`,
          );
          yield* keyvault.PutPrivateEndpointConnection({
            subscriptionId,
            resourceGroupName,
            vaultName,
            privateEndpointConnectionName: connection.name,
            properties: {
              privateLinkServiceConnectionState: {
                status: "Approved",
                description: "approved by the test",
              },
            },
          });
        }
      }
    }
  }).pipe(
    Effect.ignoreCause({ log: "Warn" }),
    Effect.repeat({ schedule: Schedule.spaced("10 seconds"), times: 120 }),
  );

type Props = { target: "A" | "B"; requestMessage: string };

/** Primary service, both vaults, and the primary link (no replica yet). */
const base = (props: Props) =>
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
    return { group, service, vaultA, vaultB, target, primaryLink };
  });

const program = (props: Props) =>
  Effect.gen(function* () {
    const { group, service, vaultA, vaultB, target, primaryLink } =
      yield* base(props);
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
    return { group, service, vaultA, vaultB, replica, target, link };
  });

// Premium_P1 primary + replica (~$0.08/hour per unit) and two vaults:
// ~$0.05 per run, ~15 minutes. Azure replicates a primary link only after
// the target approves it, so the test approves the vaults' pending
// connections as their owner. Runs only with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "track, replace, and forget a replica shared private link resource",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        base({ target: "A", requestMessage: "first" }),
      );
      const approver = yield* Effect.forkChild(
        approvePending(initial.group.resourceGroupName, [
          initial.vaultA.vaultName,
          initial.vaultB.vaultName,
        ]),
      );

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
      yield* Fiber.interrupt(approver);
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
  { tags, timeout: 1_800_000 },
);
