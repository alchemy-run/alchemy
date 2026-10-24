import * as Azure from "@alchemy.run/azure";
import * as webpubsub from "@distilled.cloud/azure/webpubsub";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getLink = (
  resourceGroupName: string,
  resourceName: string,
  sharedPrivateLinkResourceName: string,
) =>
  Effect.gen(function* () {
    return yield* webpubsub.GetWebPubSubSharedPrivateLinkResource({
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
    const service = yield* Azure.WebPubSub.WebPubSub("PubSub", {
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
    const link = yield* Azure.WebPubSub.SharedPrivateLinkResource("VaultLink", {
      resourceGroup: group.resourceGroupName,
      webPubSub: service.webPubSubName,
      groupId: "vault",
      privateLinkResourceId: target.vaultId,
      requestMessage: props.requestMessage,
    });
    return { group, service, target, link };
  });

// Standard_S1 unit (~$0.07/hour) for ~10 minutes plus two vaults (free at
// rest): well under $0.05 per run.
test.provider(
  "create, replace, and delete a Web PubSub shared private link resource",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service, target, link } = yield* stack.deploy(
        program({ target: "A", requestMessage: "first" }),
      );
      const get = (name: string) => getLink(group.resourceGroupName, service.webPubSubName, name);
      expect(link.groupId).toEqual("vault");
      expect(link.privateLinkResourceId.toLowerCase()).toEqual(target.vaultId.toLowerCase());
      const observed = yield* get(link.sharedPrivateLinkResourceName);
      expect(observed.properties?.requestMessage).toEqual("first");
      expect(observed.properties?.privateLinkResourceId?.toLowerCase()).toEqual(
        target.vaultId.toLowerCase(),
      );
      // Nobody approves the vault's private endpoint connection here.
      expect(observed.properties?.status).toEqual("Pending");
      expect(link.status).toEqual("Pending");

      // Replacement: Azure keeps the request message fixed after creation.
      const renamed = yield* stack.deploy(program({ target: "A", requestMessage: "updated" }));
      expect(renamed.link.sharedPrivateLinkResourceName).not.toEqual(
        link.sharedPrivateLinkResourceName,
      );
      const renamedObserved = yield* get(renamed.link.sharedPrivateLinkResourceName);
      expect(renamedObserved.properties?.requestMessage).toEqual("updated");
      expect(yield* waitGone(get(link.sharedPrivateLinkResourceName))).toEqual("gone");

      // Replacement: the target is fixed after creation.
      const replaced = yield* stack.deploy(program({ target: "B", requestMessage: "updated" }));
      expect(replaced.link.sharedPrivateLinkResourceName).not.toEqual(
        renamed.link.sharedPrivateLinkResourceName,
      );
      const replacedObserved = yield* get(replaced.link.sharedPrivateLinkResourceName);
      expect(replacedObserved.properties?.privateLinkResourceId?.toLowerCase()).toEqual(
        replaced.target.vaultId.toLowerCase(),
      );
      expect(replacedObserved.properties?.requestMessage).toEqual("updated");
      expect(yield* waitGone(get(renamed.link.sharedPrivateLinkResourceName))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          webpubsub.GetWebPubSub({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            resourceName: service.webPubSubName,
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
