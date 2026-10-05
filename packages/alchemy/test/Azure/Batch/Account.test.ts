import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as batch from "@distilled.cloud/azure/batch";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, regions, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAccount = (resourceGroupName: string, accountName: string) =>
  Effect.gen(function* () {
    return yield* batch.GetBatchAccount({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accountName,
    });
  });

const program = (props: {
  location: string;
  allowedAuthenticationModes?: Azure.Batch.BatchAuthenticationMode[];
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: regions.account,
    });
    const storage = yield* Azure.Storage.StorageAccount("Files", {
      resourceGroup: group.resourceGroupName,
      location: regions.account,
    });
    const account = yield* Azure.Batch.Account("Jobs", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      autoStorage: { storageAccountId: storage.storageAccountId },
      allowedAuthenticationModes: props.allowedAuthenticationModes,
      tags: props.tags,
    });
    return { group, storage, account };
  });

// Batch accounts and an empty Standard_LRS storage account are free.
test.provider(
  "create, update, replace, and delete a batch account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, storage, account } = yield* stack.deploy(
        program({ location: regions.account, tags: { env: "test" } }),
      );
      expect(account.accountName).toMatch(/^[a-z0-9]{3,24}$/);
      expect(account.location).toEqual(regions.account);
      expect(account.accountEndpoint).toContain(".batch.azure.com");
      expect(account.tags).toEqual({ env: "test" });
      expect(account.primaryKey).toBeDefined();
      expect(Redacted.value(account.primaryKey!).length).toBeGreaterThan(10);
      const observed = yield* getAccount(
        group.resourceGroupName,
        account.accountName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(
        observed.properties?.autoStorage?.storageAccountId?.toLowerCase(),
      ).toEqual(storage.storageAccountId.toLowerCase());
      expect(observed.tags?.["alchemy::id"]).toEqual("Jobs");

      // In-place: authentication modes and tags.
      const updated = yield* stack.deploy(
        program({
          location: regions.account,
          allowedAuthenticationModes: ["AAD"],
          tags: { env: "prod" },
        }),
      );
      expect(updated.account.accountId).toEqual(account.accountId);
      expect(updated.account.tags).toEqual({ env: "prod" });
      expect(updated.account.primaryKey).toBeUndefined();
      const after = yield* getAccount(
        group.resourceGroupName,
        account.accountName,
      );
      expect(after.properties?.allowedAuthenticationModes).toEqual(["AAD"]);
      expect(after.tags?.env).toEqual("prod");

      // Replacement: move to another region (one account per region).
      const replaced = yield* stack.deploy(
        program({
          location: regions.accountReplacement,
          allowedAuthenticationModes: ["AAD"],
          tags: { env: "prod" },
        }),
      );
      expect(replaced.account.location).toEqual(regions.accountReplacement);
      expect(replaced.account.accountName).not.toEqual(account.accountName);
      expect(
        (yield* getAccount(
          group.resourceGroupName,
          replaced.account.accountName,
        )).location,
      ).toEqual(regions.accountReplacement);
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
