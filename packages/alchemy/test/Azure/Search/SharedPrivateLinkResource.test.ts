import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as search from "@distilled.cloud/azure/search";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getLink = (
  resourceGroupName: string,
  searchServiceName: string,
  sharedPrivateLinkResourceName: string,
) =>
  Effect.gen(function* () {
    return yield* search.GetSharedPrivateLinkResource({
      subscriptionId: yield* subscription,
      resourceGroupName,
      searchServiceName,
      sharedPrivateLinkResourceName,
    });
  });

const program = (props: {
  groupId: "blob" | "table";
  requestMessage: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Shared private links need a basic or higher search service.
    const service = yield* Azure.Search.SearchService("Search", {
      resourceGroup: group.resourceGroupName,
      sku: "basic",
    });
    const account = yield* Azure.Storage.StorageAccount("Data", {
      resourceGroup: group.resourceGroupName,
    });
    const link = yield* Azure.Search.SharedPrivateLinkResource("Link", {
      resourceGroup: group.resourceGroupName,
      searchService: service.searchServiceName,
      privateLinkResourceId: account.storageAccountId,
      groupId: props.groupId,
      requestMessage: props.requestMessage,
    });
    return { group, service, account, link };
  });

// Basic search service (~$0.11/hour, billed per started hour) + storage
// account: ~$0.11 per run, ~6 minutes (each link takes 1-2 minutes to
// provision).
test.provider(
  "create, update, replace, and delete a shared private link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service, account, link } = yield* stack.deploy(
        program({ groupId: "blob", requestMessage: "alchemy test" }),
      );
      const get = (name: string) =>
        getLink(group.resourceGroupName, service.searchServiceName, name);
      expect(link.groupId).toEqual("blob");
      expect(link.privateLinkResourceId.toLowerCase()).toEqual(
        account.storageAccountId.toLowerCase(),
      );
      const observed = yield* get(link.sharedPrivateLinkResourceName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.requestMessage).toEqual("alchemy test");

      // In place: the approval request message.
      const updated = yield* stack.deploy(
        program({ groupId: "blob", requestMessage: "alchemy test updated" }),
      );
      expect(updated.link.sharedPrivateLinkResourceId).toEqual(
        link.sharedPrivateLinkResourceId,
      );
      const reobserved = yield* get(link.sharedPrivateLinkResourceName);
      expect(reobserved.properties?.requestMessage).toEqual(
        "alchemy test updated",
      );

      // Replacement: the target sub-resource is immutable.
      const replaced = yield* stack.deploy(
        program({ groupId: "table", requestMessage: "alchemy test updated" }),
      );
      expect(replaced.link.sharedPrivateLinkResourceName).not.toEqual(
        link.sharedPrivateLinkResourceName,
      );
      const replacedObserved = yield* get(
        replaced.link.sharedPrivateLinkResourceName,
      );
      expect(replacedObserved.properties?.groupId).toEqual("table");
      expect(yield* waitGone(get(link.sharedPrivateLinkResourceName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.link.sharedPrivateLinkResourceName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
