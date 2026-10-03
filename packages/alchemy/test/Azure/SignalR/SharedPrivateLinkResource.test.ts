import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as signalr from "@distilled.cloud/azure/signalr";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getLink = (
  resourceGroupName: string,
  resourceName: string,
  sharedPrivateLinkResourceName: string,
) =>
  Effect.gen(function* () {
    return yield* signalr.GetSignalRSharedPrivateLinkResource({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceName,
      sharedPrivateLinkResourceName,
    });
  });

const program = (props: { target: "A" | "B"; requestMessage: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Shared private links need Standard_S1 or higher.
    const service = yield* Azure.SignalR.SignalR("Realtime", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard_S1",
    });
    // Both vaults stay deployed across the replacement step.
    const vaultA = yield* Azure.KeyVault.Vault("VaultA", {
      resourceGroup: group.resourceGroupName,
      softDeleteRetentionInDays: 7,
    });
    const vaultB = yield* Azure.KeyVault.Vault("VaultB", {
      resourceGroup: group.resourceGroupName,
      softDeleteRetentionInDays: 7,
    });
    const target = props.target === "A" ? vaultA : vaultB;
    const link = yield* Azure.SignalR.SharedPrivateLinkResource("Vault", {
      resourceGroup: group.resourceGroupName,
      signalR: service.signalRName,
      groupId: "vault",
      privateLinkResourceId: target.vaultId,
      requestMessage: props.requestMessage,
    });
    return { group, service, target, link };
  });

// Standard_S1 unit (~$0.07/hour) for ~10 minutes plus two vaults (free at
// rest): well under $0.05 per run.
test.provider(
  "create, replace, and delete a shared private link resource",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service, target, link } = yield* stack.deploy(
        program({ target: "A", requestMessage: "first" }),
      );
      const get = (name: string) =>
        getLink(group.resourceGroupName, service.signalRName, name);
      expect(link.groupId).toEqual("vault");
      expect(link.privateLinkResourceId.toLowerCase()).toEqual(
        target.vaultId.toLowerCase(),
      );
      const observed = yield* get(link.sharedPrivateLinkResourceName);
      expect(observed.properties?.requestMessage).toEqual("first");
      expect(observed.properties?.privateLinkResourceId?.toLowerCase()).toEqual(
        target.vaultId.toLowerCase(),
      );
      expect(observed.properties?.status).toBeDefined();

      // Replacement: the target and request message are fixed after
      // creation.
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
      expect(replacedObserved.properties?.requestMessage).toEqual("second");
      expect(yield* waitGone(get(link.sharedPrivateLinkResourceName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(
          signalr.GetSignalR({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            resourceName: service.signalRName,
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
