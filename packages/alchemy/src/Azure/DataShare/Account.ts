import * as datashare from "@distilled.cloud/azure/datashare";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { getAccount, sameName } from "./internal.ts";

export interface AccountProps {
  /** Resource group the account is created in. Changing it replaces the account. */
  resourceGroup: string;
  /**
   * Account name, 3-90 characters (no `<>%&:\?/#*$^();,.|+={}[]!~@`). If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the account.
   */
  name?: string;
  /**
   * Azure location of the account. Changing it replaces the account.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Account extends Resource<
  "Azure.DataShare.Account",
  AccountProps,
  {
    /** Name of the account. */
    accountName: string;
    /** Resource group that holds the account. */
    resourceGroup: string;
    /** ARM resource ID of the account. */
    accountId: string;
    /** Location of the account. */
    location: string;
    /**
     * Object ID of the account's system-assigned managed identity. Grant it
     * `Storage Blob Data Reader` on shared sources (provider side) or
     * `Storage Blob Data Contributor` on mapped targets (consumer side).
     */
    principalId: string;
    /** Microsoft Entra tenant of the managed identity. */
    tenantId: string;
    /** Provisioning state reported by Azure. */
    provisioningState: string;
    /** Time the account was created. */
    createdAt: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Data Share account — the top-level container for shares you
 * offer (provider side) and share subscriptions you receive (consumer
 * side). Every account gets a system-assigned managed identity that Data
 * Share uses to read shared stores and write mapped targets.
 *
 * Accounts are free; Data Share bills per snapshot execution and data
 * moved.
 *
 * @see https://learn.microsoft.com/azure/data-share/overview
 *
 * ### Creating an Account
 * **Example:** Account in a resource group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("data");
 * const account = yield* Azure.DataShare.Account("sharing", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * ### Granting the Account Access
 * **Example:** Let the account read a storage account it shares from
 * ```typescript
 * yield* Azure.Authorization.RoleAssignment("share-reads-source", {
 *   scope: storage.storageAccountId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataReader,
 *   principalId: account.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * @resource
 */
export const Account = Resource<Account>("Azure.DataShare.Account");

type ObservedAccount =
  | datashare.GetAccountResponse
  | datashare.CreateAccountResponse
  | datashare.Account;

const createAccountName = (id: string) =>
  createPhysicalName({ id, maxLength: 90 });

const toAttrs = (
  resourceGroup: string,
  name: string,
  account: ObservedAccount,
): Account["Attributes"] => ({
  accountName: name,
  resourceGroup,
  accountId: account.id ?? "",
  location: account.location ?? "",
  principalId: account.identity?.principalId ?? "",
  tenantId: account.identity?.tenantId ?? "",
  provisioningState: account.properties?.provisioningState ?? "Succeeded",
  createdAt: account.properties?.createdAt,
  tags: userTags(account.tags),
});

export const AccountProvider = () =>
  Provider.succeed(Account, {
    stables: [
      "accountName",
      "resourceGroup",
      "accountId",
      "location",
      "principalId",
      "tenantId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* datashare
        .ListAccountBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAccountBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((account) => {
        const group = resourceGroupOf(account.id);
        return hasAnyAlchemyTag(account.tags) &&
          group !== undefined &&
          account.name !== undefined
          ? [toAttrs(group, account.name, account)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameName(news.name, output.accountName)) ||
        (news.location !== undefined &&
          !sameName(
            news.location.replaceAll(" ", ""),
            output.location.replaceAll(" ", ""),
          ))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its resource group.
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.accountName ?? olds?.name ?? (yield* createAccountName(id));
      const observed = yield* getAccount(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DataShare");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.accountName ?? (yield* createAccountName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: name,
      };
      const get = getAccount(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure. The PUT is a long-running create (201 + `Creating`).
      if (observed === undefined) {
        yield* datashare.CreateAccount({
          ...where,
          location,
          tags,
          identity: { type: "SystemAssigned" },
        });
      }
      let fresh = yield* waitForProvisioned(
        `data share account ${name}`,
        get,
        (account) => account.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Sync tags (the only mutable aspect) against the observed account.
      if (tagsDiffer(fresh.tags, tags)) {
        yield* datashare.UpdateAccount({ ...where, tags });
        fresh = yield* waitForProvisioned(
          `data share account ${name}`,
          get,
          (account) => account.properties?.provisioningState,
          { interval: "3 seconds", times: 20 },
        );
      }

      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datashare.DeleteAccount({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.accountName,
        }),
      );
      yield* waitUntilGone(
        `data share account ${output.accountName}`,
        getAccount(subscriptionId, output.resourceGroup, output.accountName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
