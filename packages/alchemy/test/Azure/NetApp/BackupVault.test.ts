import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as netapp from "@distilled.cloud/azure/netapp";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { accountBase, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVault = (
  resourceGroupName: string,
  accountName: string,
  backupVaultName: string,
) =>
  Effect.gen(function* () {
    return yield* netapp.GetBackupVault({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accountName,
      backupVaultName,
    });
  });

const program = (props: { tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const { group, account } = yield* accountBase;
    const vault = yield* Azure.NetApp.BackupVault("Vault", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      tags: props.tags,
    });
    return { group, account, vault };
  });

// Free (account + vault, ~2 minutes), but free-trial subscriptions cannot
// create NetApp accounts (`NetAppCreationRestricted`, probed in
// Account.test.ts).
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a backup vault",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, vault } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const get = () =>
        getVault(
          group.resourceGroupName,
          account.accountName,
          vault.backupVaultName,
        );
      const observed = yield* get();
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      // In place: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.vault.backupVaultId).toEqual(vault.backupVaultId);
      expect((yield* get()).tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
