import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Azure.providers() });

const getService = (resourceGroupName: string, accountName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetTableServiceServiceProperties({
      subscriptionId,
      resourceGroupName,
      accountName,
    });
  });

const program = (cors?: Azure.Storage.StorageCorsRule[]) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const settings = cors
      ? yield* Azure.Storage.TableServiceProperties("TableSettings", {
          resourceGroup: group.resourceGroupName,
          storageAccount: account.storageAccountName,
          cors,
        })
      : undefined;
    return { group, account, settings };
  });

// Standard_LRS account with no data: ~$0, ~1 minute.
test.provider(
  "configure, update, and reset table service CORS",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program([
          {
            allowedOrigins: ["https://app.example.com"],
            allowedMethods: ["GET", "OPTIONS"],
            maxAgeInSeconds: 600,
          },
        ]),
      );
      const rg = created.group.resourceGroupName;
      const acct = created.account.storageAccountName;
      expect(created.settings!.tableServiceId).toContain("tableServices");
      const observed = yield* getService(rg, acct);
      expect(observed.properties?.cors?.corsRules?.[0]?.allowedOrigins).toEqual(
        ["https://app.example.com"],
      );
      expect(
        observed.properties?.cors?.corsRules?.[0]?.maxAgeInSeconds,
      ).toEqual(600);

      // In-place update: a different origin and method set.
      const updated = yield* stack.deploy(
        program([
          {
            allowedOrigins: ["https://admin.example.com"],
            allowedMethods: ["GET"],
          },
        ]),
      );
      expect(updated.settings!.cors.map((r) => r.allowedOrigins)).toEqual([
        ["https://admin.example.com"],
      ]);
      const reobserved = yield* getService(rg, acct);
      expect(
        reobserved.properties?.cors?.corsRules?.map((r) => r.allowedMethods),
      ).toEqual([["GET"]]);

      // Removing the resource removes the managed CORS rules.
      yield* stack.deploy(program());
      const reset = yield* getService(rg, acct);
      expect(reset.properties?.cors?.corsRules ?? []).toEqual([]);

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 600_000,
  },
);
