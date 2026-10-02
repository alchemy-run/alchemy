import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Azure.providers() });

const getScope = (
  resourceGroupName: string,
  accountName: string,
  encryptionScopeName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetEncryptionScope({
      subscriptionId,
      resourceGroupName,
      accountName,
      encryptionScopeName,
    });
  });

const program = (scope?: { enabled?: boolean }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const encryptionScope = scope
      ? yield* Azure.Storage.EncryptionScope("Scope", {
          resourceGroup: group.resourceGroupName,
          storageAccount: account.storageAccountName,
          enabled: scope.enabled,
        })
      : undefined;
    return { group, account, encryptionScope };
  });

test.provider(
  "create, disable, re-enable, and delete (disable) an encryption scope",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({}));
      const rg = created.group.resourceGroupName;
      const acct = created.account.storageAccountName;
      const scope = created.encryptionScope!;
      expect(scope.source).toEqual("Microsoft.Storage");
      expect(scope.state).toEqual("Enabled");
      const observed = yield* getScope(rg, acct, scope.encryptionScopeName);
      expect(observed.properties?.state).toEqual("Enabled");
      expect(observed.properties?.source).toEqual("Microsoft.Storage");

      // In-place update: disable the scope.
      const disabled = yield* stack.deploy(program({ enabled: false }));
      expect(disabled.encryptionScope!.state).toEqual("Disabled");
      expect(
        (yield* getScope(rg, acct, scope.encryptionScopeName)).properties
          ?.state,
      ).toEqual("Disabled");

      // And back on.
      yield* stack.deploy(program({ enabled: true }));
      expect(
        (yield* getScope(rg, acct, scope.encryptionScopeName)).properties
          ?.state,
      ).toEqual("Enabled");

      // Azure cannot delete scopes: removing it from the stack disables it.
      yield* stack.deploy(program());
      expect(
        (yield* getScope(rg, acct, scope.encryptionScopeName)).properties
          ?.state,
      ).toEqual("Disabled");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 600_000,
  },
);
