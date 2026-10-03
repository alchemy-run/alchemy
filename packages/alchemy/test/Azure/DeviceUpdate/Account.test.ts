import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as deviceupdate from "@distilled.cloud/azure/deviceupdate";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAccount = (resourceGroupName: string, accountName: string) =>
  Effect.gen(function* () {
    return yield* deviceupdate.GetAccount({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accountName,
    });
  });

const program = (props: {
  sku: "Free" | "Standard";
  publicNetworkAccess: "Enabled" | "Disabled";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.DeviceUpdate.Account("Account", {
      resourceGroup: group.resourceGroupName,
      sku: props.sku,
      publicNetworkAccess: props.publicNetworkAccess,
      tags: props.tags,
    });
    return { group, account };
  });

// Free account ($0, one per subscription) replaced by a Standard account
// (~$0.27/hour, deleted within minutes): well under $0.10 per run.
test.provider(
  "create, update, replace, and delete a device update account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(
        program({
          sku: "Free",
          publicNetworkAccess: "Enabled",
          tags: { env: "test" },
        }),
      );
      expect(account.sku).toEqual("Free");
      expect(account.hostName).toContain("api.adu.microsoft.com");
      expect(account.tags).toEqual({ env: "test" });
      const observed = yield* getAccount(
        group.resourceGroupName,
        account.accountName,
      );
      expect(observed.properties?.sku).toEqual("Free");
      expect(observed.properties?.publicNetworkAccess).toEqual("Enabled");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Account");

      // In place: disable public access and change tags.
      const updated = yield* stack.deploy(
        program({
          sku: "Free",
          publicNetworkAccess: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(updated.account.accountId).toEqual(account.accountId);
      const reobserved = yield* getAccount(
        group.resourceGroupName,
        account.accountName,
      );
      expect(reobserved.properties?.publicNetworkAccess).toEqual("Disabled");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the SKU is immutable.
      const replaced = yield* stack.deploy(
        program({
          sku: "Standard",
          publicNetworkAccess: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.account.accountName).not.toEqual(account.accountName);
      const replacedObserved = yield* getAccount(
        group.resourceGroupName,
        replaced.account.accountName,
      );
      expect(replacedObserved.properties?.sku).toEqual("Standard");
      expect(
        yield* waitGone(
          getAccount(group.resourceGroupName, account.accountName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getAccount(group.resourceGroupName, replaced.account.accountName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
