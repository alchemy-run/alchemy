import * as logic from "@distilled.cloud/azure/logic";
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
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createLogicName } from "./LogicShared.ts";

/** Integration account pricing tier. */
export type IntegrationAccountSkuName = "Free" | "Basic" | "Standard";

export interface IntegrationAccountProps {
  /**
   * Resource group the account is created in. Changing it replaces the
   * account.
   */
  resourceGroup: string;
  /**
   * Account name: 1-80 letters, digits, `-`, `_`, `.`, `(`, `)`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the account.
   */
  name?: string;
  /**
   * Azure location of the account. Workflows that use it must be in the
   * same location. Changing it replaces the account.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Pricing tier. `Free` is limited to one account per region per
   * subscription and has no SLA. Upgrades (`Free` → `Basic` → `Standard`)
   * apply in place; a downgrade replaces the account.
   * @default "Free"
   */
  sku?: IntegrationAccountSkuName;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface IntegrationAccount extends Resource<
  "Azure.Logic.IntegrationAccount",
  IntegrationAccountProps,
  {
    /** Name of the integration account. */
    integrationAccountName: string;
    /** Resource group that holds the account. */
    resourceGroup: string;
    /** ARM resource ID; pass it as a workflow's `integrationAccount`. */
    integrationAccountId: string;
    /** Location of the account. */
    location: string;
    /** Pricing tier. */
    sku: string;
    /**
     * Account state reported by Azure. ARM accepts `properties.state` on
     * PUT but ignores it (the account stays `Enabled`), so it is read-only.
     */
    state: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Logic Apps integration account — the container for B2B and
 * enterprise-integration artifacts (schemas, maps, partners, agreements,
 * certificates, assemblies, batch configurations) that Consumption
 * workflows use for XML validation, transforms, and AS2/X12/EDIFACT
 * messaging.
 *
 * @see https://learn.microsoft.com/azure/logic-apps/logic-apps-enterprise-integration-create-integration-account
 *
 * ### Creating an Integration Account
 * **Example:** Free integration account
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("b2b");
 * const account = yield* Azure.Logic.IntegrationAccount("b2b", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Standard account with tags
 * ```typescript
 * const account = yield* Azure.Logic.IntegrationAccount("b2b", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Standard",
 *   tags: { team: "integration" },
 * });
 * ```
 *
 * ### Linking a Workflow
 * **Example:** Workflow that uses the account's artifacts
 * ```typescript
 * const workflow = yield* Azure.Logic.Workflow("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   integrationAccount: account.integrationAccountId,
 *   definition,
 * });
 * ```
 *
 * @resource
 */
export const IntegrationAccount = Resource<IntegrationAccount>(
  "Azure.Logic.IntegrationAccount",
);

const SKU_RANK: Record<string, number> = { free: 0, basic: 1, standard: 2 };

const getAccount = (
  subscriptionId: string,
  resourceGroupName: string,
  integrationAccountName: string,
) =>
  orUndefinedIfNotFound(
    logic.GetIntegrationAccount({
      subscriptionId,
      resourceGroupName,
      integrationAccountName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  account: logic.GetIntegrationAccountResponse,
): IntegrationAccount["Attributes"] => ({
  integrationAccountName: name,
  resourceGroup,
  integrationAccountId: account.id ?? "",
  location: account.location ?? "",
  sku: account.sku?.name ?? "",
  state: account.properties?.state ?? "",
  tags: userTags(account.tags),
});

export const IntegrationAccountProvider = () =>
  Provider.succeed(IntegrationAccount, {
    stables: [
      "integrationAccountName",
      "resourceGroup",
      "integrationAccountId",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* logic
        .ListIntegrationAccountBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListIntegrationAccountBySubscription", page),
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
      const sku = (news.sku ?? "Free").toLowerCase();
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.integrationAccountName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase()) ||
        // Azure rejects SKU downgrades in place.
        (SKU_RANK[sku] ?? 0) < (SKU_RANK[output.sku.toLowerCase()] ?? 0)
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
        output?.integrationAccountName ??
        olds?.name ??
        (yield* createLogicName(id));
      const observed = yield* getAccount(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Logic");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.integrationAccountName ??
        (yield* createLogicName(id));
      const location = news.location ?? output?.location ?? env.location;
      const sku = news.sku ?? "Free";
      const tags = yield* desiredTags(id, news.tags);

      // Observe.
      let observed = yield* getAccount(subscriptionId, resourceGroup, name);

      // Ensure + sync: the PUT is a synchronous upsert of sku and tags, so
      // one PUT covers a missing account or any observed delta. PATCH
      // rejects `properties`, and PUT ignores `properties.state`.
      if (
        observed === undefined ||
        observed.sku?.name?.toLowerCase() !== sku.toLowerCase() ||
        tagsDiffer(observed.tags, tags)
      ) {
        observed = yield* logic.IntegrationAccountsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          integrationAccountName: name,
          location: observed?.location ?? location,
          sku: { name: sku },
          // Required: a PUT without `properties` is rejected as invalid.
          properties: {},
          tags,
        });
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        logic.DeleteIntegrationAccount({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          integrationAccountName: output.integrationAccountName,
        }),
      );
      yield* waitUntilGone(
        `integration account ${output.integrationAccountName}`,
        getAccount(
          subscriptionId,
          output.resourceGroup,
          output.integrationAccountName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
