import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as keyvault from "@distilled.cloud/azure/keyvault";
import * as webpubsub from "@distilled.cloud/azure/webpubsub";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
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
    return yield* webpubsub.GetWebPubSubReplicaSharedPrivateLinkResource({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceName,
      replicaName,
      sharedPrivateLinkResourceName,
    });
  });

/**
 * Web PubSub replicates a primary shared private link to its replicas only
 * after the target approves the private endpoint connection. Approve every
 * pending connection on the vault (we own both sides in this test).
 */
const approvePending = (resourceGroupName: string, vaultName: string) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    const connections = yield* keyvault.ListPrivateEndpointConnectionByResource(
      { subscriptionId, resourceGroupName, vaultName },
    );
    let approved = 0;
    for (const connection of connections.value ?? []) {
      // A connection can only be approved once it finished provisioning.
      if (
        connection.name === undefined ||
        connection.properties?.provisioningState !== "Succeeded" ||
        connection.properties?.privateLinkServiceConnectionState?.status !==
          "Pending"
      ) {
        continue;
      }
      yield* keyvault.PutPrivateEndpointConnection({
        subscriptionId,
        resourceGroupName,
        vaultName,
        privateEndpointConnectionName: connection.name,
        properties: {
          privateLinkServiceConnectionState: {
            status: "Approved",
            description: "alchemy test",
          },
        },
      });
      approved++;
    }
    return approved;
  });

/** Keep approving pending connections on a vault (runs alongside a deploy). */
const keepApproving = (resourceGroupName: string, vaultName: string) =>
  approvePending(resourceGroupName, vaultName).pipe(
    // A connection mid-transition rejects approval; the next round retries.
    Effect.ignore,
    Effect.repeat({ schedule: Schedule.spaced("10 seconds"), times: 80 }),
    Effect.asVoid,
  );

const program = (props: {
  target: "A" | "B";
  requestMessage: string;
  replicaLink: boolean;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Replicas need a Premium service.
    const service = yield* Azure.WebPubSub.WebPubSub("PubSub", {
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
    const primaryLink = yield* Azure.WebPubSub.SharedPrivateLinkResource(
      "VaultLink",
      {
        resourceGroup: group.resourceGroupName,
        webPubSub: service.webPubSubName,
        groupId: "vault",
        privateLinkResourceId: target.vaultId,
        requestMessage: props.requestMessage,
      },
    );
    // Primary links replicate to replicas created after them.
    const replica = yield* Azure.WebPubSub.Replica("West", {
      resourceGroup: group.resourceGroupName,
      webPubSub: Output.all(
        service.webPubSubName,
        primaryLink.sharedPrivateLinkResourceId,
      ).pipe(Output.map(([name]) => name)),
      location: "westus2",
    });
    if (!props.replicaLink) {
      return { group, service, replica, target, vaultB, link: undefined };
    }
    const link = yield* Azure.WebPubSub.ReplicaSharedPrivateLinkResource(
      "WestLink",
      {
        resourceGroup: group.resourceGroupName,
        webPubSub: service.webPubSubName,
        replica: replica.replicaName,
        sharedPrivateLinkResource: primaryLink.sharedPrivateLinkResourceName,
        groupId: "vault",
        privateLinkResourceId: target.vaultId,
      },
    );
    return { group, service, replica, target, vaultB, link };
  });

// Premium_P1 primary + replica (~$0.07/hour per unit) and two vaults:
// ~$0.05 per run, but ~15 minutes (two link approvals and replications), so
// it only runs with AZURE_TEST_EXPENSIVE=1 (with a longer --timeout).
test.provider.skipIf(!runExpensive)(
  "track, replace, and forget a replica shared private link resource",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Primary link + replica first; the copy appears once approved.
      const base = yield* stack.deploy(
        program({ target: "A", requestMessage: "first", replicaLink: false }),
      );
      expect(
        yield* approvePending(
          base.group.resourceGroupName,
          base.target.vaultName,
        ).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (approved) => approved > 0,
            times: 30,
          }),
        ),
      ).toBeGreaterThan(0);
      const { group, service, replica, target, vaultB, link } =
        yield* stack.deploy(
          program({ target: "A", requestMessage: "first", replicaLink: true }),
        );
      if (link === undefined) return yield* Effect.die("link missing");
      const get = (name: string) =>
        getLink(
          group.resourceGroupName,
          service.webPubSubName,
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
      // The new primary link to vault B must be approved before its copy
      // appears, so approve alongside the deploy.
      const replaced = yield* stack
        .deploy(
          program({ target: "B", requestMessage: "second", replicaLink: true }),
        )
        .pipe(
          Effect.raceFirst(
            keepApproving(group.resourceGroupName, vaultB.vaultName).pipe(
              Effect.andThen(Effect.never),
            ),
          ),
        );
      if (replaced.link === undefined) return yield* Effect.die("link missing");
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
          webpubsub.GetWebPubSubReplicas({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            resourceName: service.webPubSubName,
            replicaName: replica.replicaName,
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
