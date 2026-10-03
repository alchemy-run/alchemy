import * as netapp from "@distilled.cloud/azure/netapp";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  accountLocation,
  createNetAppName,
  accountRefs,
  listAllAccounts,
  LRO_BUDGET,
  parseNetAppId,
  whileBusy,
} from "./Common.ts";

export interface BackupVaultProps {
  /** Resource group of the NetApp account. Changing it replaces the vault. */
  resourceGroup: string;
  /** Name of the NetApp account. Changing it replaces the vault. */
  account: string;
  /**
   * Vault name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the vault.
   */
  name?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface BackupVault extends Resource<
  "Azure.NetApp.BackupVault",
  BackupVaultProps,
  {
    /** Name of the backup vault. */
    backupVaultName: string;
    /** ARM resource ID of the vault; assign it to volumes via `backupVaultId`. */
    backupVaultId: string;
    /** Parent NetApp account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Location of the vault. */
    location: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure NetApp Files backup vault — the container that holds volume
 * backups taken manually or by a backup policy. The vault is free; stored
 * backups are billed.
 *
 * @see https://learn.microsoft.com/azure/azure-netapp-files/backup-vault-manage
 *
 * ### Creating a Backup Vault
 * **Example:** Backup vault
 * ```typescript
 * const vault = yield* Azure.NetApp.BackupVault("vault", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 * });
 * ```
 *
 * **Example:** Tagged vault
 * ```typescript
 * const vault = yield* Azure.NetApp.BackupVault("vault", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   tags: { team: "storage" },
 * });
 * ```
 *
 * @resource
 */
export const BackupVault = Resource<BackupVault>("Azure.NetApp.BackupVault");

const getBackupVault = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  backupVaultName: string,
) =>
  orUndefinedIfNotFound(
    netapp.GetBackupVault({
      subscriptionId,
      resourceGroupName,
      accountName,
      backupVaultName,
    }),
  );

type ObservedVault = netapp.GetBackupVaultResponse | netapp.BackupVault;

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  vault: ObservedVault,
): BackupVault["Attributes"] => ({
  backupVaultName: name,
  backupVaultId: vault.id ?? "",
  account,
  resourceGroup,
  location: vault.location ?? "",
  tags: userTags(vault.tags),
});

export const BackupVaultProvider = () =>
  Provider.succeed(BackupVault, {
    stables: [
      "backupVaultName",
      "backupVaultId",
      "account",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const accounts = yield* listAllAccounts(subscriptionId);
      const vaults = yield* Effect.forEach(
        accountRefs(accounts),
        ({ resourceGroup, accountName }) =>
          orUndefinedIfNotFound(
            netapp
              .ListBackupVaultByNetAppAccount({
                subscriptionId,
                resourceGroupName: resourceGroup,
                accountName,
              })
              .pipe(
                Effect.flatMap((page) =>
                  requireSinglePage("ListBackupVaultByNetAppAccount", page),
                ),
              ),
          ).pipe(Effect.map((page) => page?.value ?? [])),
      );
      return vaults.flat().flatMap((vault) => {
        const { resourceGroup, account, name } = parseNetAppId(vault.id);
        return hasAnyAlchemyTag(vault.tags) && resourceGroup && account && name
          ? [toAttrs(resourceGroup, account, name, vault)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account.toLowerCase() !== output.account.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.backupVaultName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      if (!resourceGroup || !account) return undefined;
      const name =
        output?.backupVaultName ??
        olds?.name ??
        (yield* createNetAppName(id, 64));
      const observed = yield* getBackupVault(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.NetApp");
      const { resourceGroup, account } = news;
      const name =
        news.name ??
        output?.backupVaultName ??
        (yield* createNetAppName(id, 64));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        backupVaultName: name,
      };
      const get = getBackupVault(subscriptionId, resourceGroup, account, name);
      const waitReady = waitForProvisioned(
        `backup vault ${name}`,
        get,
        (vault) => vault.properties?.provisioningState,
        LRO_BUDGET,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const location =
          output?.location ??
          (yield* accountLocation(subscriptionId, resourceGroup, account));
        yield* whileBusy(
          netapp.BackupVaultsCreateOrUpdate({
            ...where,
            location,
            tags,
            properties: {},
          }),
        );
      }
      observed = yield* waitReady;

      // Sync tags (the only mutable aspect) against observed state.
      if (tagsDiffer(observed.tags, tags)) {
        yield* whileBusy(netapp.UpdateBackupVault({ ...where, tags }));
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, account, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* whileBusy(
        ignoreNotFound(
          netapp.DeleteBackupVault({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            backupVaultName: output.backupVaultName,
          }),
        ),
      );
      yield* waitUntilGone(
        `backup vault ${output.backupVaultName}`,
        getBackupVault(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.backupVaultName,
        ),
        LRO_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.NetApp.Account", "Azure.Resources.ResourceGroup"],
    },
  });
