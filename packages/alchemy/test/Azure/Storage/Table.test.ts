import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getTable = (
  resourceGroupName: string,
  accountName: string,
  tableName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetTable({
      subscriptionId,
      resourceGroupName,
      accountName,
      tableName,
    });
  });

const tableGone = (
  resourceGroupName: string,
  accountName: string,
  tableName: string,
) =>
  getTable(resourceGroupName, accountName, tableName).pipe(
    Effect.as("found" as const),
    Effect.catchTag("ResourceNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const program = (table?: {
  name?: string;
  accessPolicies?: Azure.Storage.StorageAccessPolicy[];
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const users = table
      ? yield* Azure.Storage.Table("Users", {
          resourceGroup: group.resourceGroupName,
          storageAccount: account.storageAccountName,
          name: table.name,
          accessPolicies: table.accessPolicies,
        })
      : undefined;
    return { group, account, users };
  });

test.provider(
  "create, update, replace, and delete a storage table",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({}));
      const rg = created.group.resourceGroupName;
      const acct = created.account.storageAccountName;
      const first = created.users!;
      expect(first.tableName).toMatch(/^[a-z][a-z0-9]{2,62}$/);
      expect(first.accessPolicies).toEqual([]);
      const observed = yield* getTable(rg, acct, first.tableName);
      expect(observed.properties?.signedIdentifiers ?? []).toEqual([]);

      // In-place update: add a stored access policy.
      const updated = yield* stack.deploy(
        program({
          accessPolicies: [
            {
              id: "readers",
              permission: "r",
              startTime: "2026-01-01T00:00:00Z",
              expiryTime: "2030-01-01T00:00:00Z",
            },
          ],
        }),
      );
      expect(updated.users!.tableName).toEqual(first.tableName);
      const reobserved = yield* getTable(rg, acct, first.tableName);
      expect(
        reobserved.properties?.signedIdentifiers?.map((policy) => [
          policy.id,
          policy.accessPolicy?.permission,
        ]),
      ).toEqual([["readers", "r"]]);

      // Renaming replaces the table.
      const renamed = yield* stack.deploy(
        program({ name: "alchemyrenamedtable" }),
      );
      expect(renamed.users!.tableName).toEqual("alchemyrenamedtable");
      yield* getTable(rg, acct, "alchemyrenamedtable");
      expect(yield* tableGone(rg, acct, first.tableName)).toEqual("gone");

      // Removing the table from the stack deletes it.
      yield* stack.deploy(program());
      expect(yield* tableGone(rg, acct, "alchemyrenamedtable")).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 600_000,
  },
);
