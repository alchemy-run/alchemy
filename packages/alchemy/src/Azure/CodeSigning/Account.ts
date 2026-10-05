import * as codesigning from "@distilled.cloud/azure/codesigning";
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
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/** Pricing tier of an Artifact Signing account. */
export type CodeSigningAccountSku = "Basic" | "Premium";

export interface AccountProps {
  /**
   * Resource group the account is created in. Changing it replaces the
   * account.
   */
  resourceGroup: string;
  /**
   * Globally unique account name, 3-24 characters of letters, digits, and
   * single hyphens, starting with a letter and ending with a letter or
   * digit. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the account.
   */
  name?: string;
  /**
   * Azure location of the account. Artifact Signing is offered in a limited
   * set of regions (e.g. `eastus`, `westus`, `westus2`, `westcentralus`,
   * `northeurope`, `westeurope`). Changing it replaces the account.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Pricing tier. `Basic` includes 5,000 signatures and one certificate
   * profile of each type per month; `Premium` raises both limits. Updated
   * in place.
   * @default "Basic"
   */
  sku?: CodeSigningAccountSku;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Account extends Resource<
  "Azure.CodeSigning.Account",
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
     * Regional signing endpoint of the account (e.g.
     * `https://eus.codesigning.azure.net/`), passed to SignTool or the
     * signing GitHub Action.
     */
    accountUri: string;
    /** Pricing tier of the account. */
    sku: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Artifact Signing (formerly Trusted Signing) account — the top-level
 * container for identity validations and certificate profiles used to sign
 * Windows binaries, MSIX packages, and other artifacts with Microsoft-managed
 * certificates.
 *
 * Artifact Signing is not available on free-trial, free, or sponsored
 * subscriptions; the create is rejected with
 * `CodeSigningSubscriptionNotSupported`. The monthly SKU fee is billed in
 * full when the account is created.
 *
 * @see https://learn.microsoft.com/azure/artifact-signing/overview
 *
 * ### Creating an Account
 * **Example:** Basic account
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("signing", {
 *   location: "eastus",
 * });
 * const account = yield* Azure.CodeSigning.Account("signing", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * // account.accountUri -> "https://eus.codesigning.azure.net/"
 * ```
 *
 * **Example:** Premium account with tags
 * ```typescript
 * const account = yield* Azure.CodeSigning.Account("signing", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Premium",
 *   tags: { team: "release" },
 * });
 * ```
 *
 * ### Adding a Certificate Profile
 * **Example:** Public-trust profile for an identity validation
 * ```typescript
 * const profile = yield* Azure.CodeSigning.CertificateProfile("release", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   profileType: "PublicTrust",
 *   identityValidationId: "00000000-0000-0000-0000-000000000000",
 * });
 * ```
 *
 * @resource
 */
export const Account = Resource<Account>("Azure.CodeSigning.Account");

type ObservedAccount = codesigning.GetCodeSigningAccountResponse;

/**
 * Generate a valid account name: 3-24 lowercase letters and digits,
 * starting with a letter (hyphens are allowed but never consecutively, so
 * they are dropped).
 */
const createAccountName = Effect.fn(function* (id: string) {
  const name = (yield* createPhysicalName({
    id,
    maxLength: 24,
    lowercase: true,
    delimiter: "",
  })).replace(/[^a-z0-9]/g, "");
  return /^[a-z]/.test(name) ? name : `a${name}`.slice(0, 24);
});

export const getCodeSigningAccount = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    codesigning.GetCodeSigningAccount({
      subscriptionId,
      resourceGroupName,
      accountName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  account: ObservedAccount,
): Account["Attributes"] => ({
  accountName: name,
  resourceGroup,
  accountId: account.id ?? "",
  location: account.location,
  accountUri: account.properties?.accountUri ?? "",
  sku: account.properties?.sku?.name ?? "",
  tags: userTags(account.tags),
});

export const AccountProvider = () =>
  Provider.succeed(Account, {
    stables: ["accountName", "resourceGroup", "accountId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* codesigning
        .ListCodeSigningAccountBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListCodeSigningAccountBySubscription", page),
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
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.accountName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.accountName ?? olds?.name ?? (yield* createAccountName(id));
      const observed = yield* getCodeSigningAccount(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.CodeSigning");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.accountName ?? (yield* createAccountName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = news.sku ?? "Basic";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: name,
      };
      const label = `artifact signing account ${name}`;
      const get = getCodeSigningAccount(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* codesigning.CreateCodeSigningAccount({
          ...where,
          location,
          tags,
          properties: { sku: { name: sku } },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (account) => account.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );

      // Sync SKU and tags against observed state; PATCH only the deltas.
      const skuChanged = observed.properties?.sku?.name !== sku;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (skuChanged || tagsChanged) {
        yield* codesigning.UpdateCodeSigningAccount({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: skuChanged ? { sku: { name: sku } } : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (account) => account.properties?.provisioningState,
          { interval: "3 seconds", times: 60 },
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        codesigning.DeleteCodeSigningAccount({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.accountName,
        }),
      );
      yield* waitUntilGone(
        `artifact signing account ${output.accountName}`,
        getCodeSigningAccount(
          subscriptionId,
          output.resourceGroup,
          output.accountName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
