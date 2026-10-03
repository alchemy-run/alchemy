import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
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
  CHILD_BUDGET,
  createChildName,
  sameArm,
  whileAccountBusy,
} from "./Common.ts";

export interface RaiBlocklistItemProps {
  /** Resource group of the account. Changing it replaces the item. */
  resourceGroup: string;
  /** Account that holds the blocklist. Changing it replaces the item. */
  account: string;
  /** Blocklist that holds the item. Changing it replaces the item. */
  raiBlocklist: string;
  /**
   * Item name. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the item.
   */
  name?: string;
  /** Term to block, or a regular expression when `isRegex` is true. */
  pattern: string;
  /**
   * Treat `pattern` as a regular expression.
   * @default false
   */
  isRegex?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface RaiBlocklistItem extends Resource<
  "Azure.CognitiveServices.RaiBlocklistItem",
  RaiBlocklistItemProps,
  {
    /** Name of the item. */
    raiBlocklistItemName: string;
    /** ARM resource ID of the item. */
    raiBlocklistItemId: string;
    /** Blocklist that holds the item. */
    raiBlocklist: string;
    /** Account that holds the blocklist. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Blocked term or regular expression. */
    pattern: string;
    /** Whether `pattern` is a regular expression. */
    isRegex: boolean;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * One term or regular expression in a content-filter blocklist
 * (`Microsoft.CognitiveServices/accounts/raiBlocklists/raiBlocklistItems`).
 *
 * @see https://learn.microsoft.com/azure/ai-foundry/openai/how-to/use-blocklists
 *
 * ### Adding Items
 * **Example:** Exact term and regular expression
 * ```typescript
 * yield* Azure.CognitiveServices.RaiBlocklistItem("secret", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   raiBlocklist: blocklist.raiBlocklistName,
 *   pattern: "top secret",
 * });
 * yield* Azure.CognitiveServices.RaiBlocklistItem("codename", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   raiBlocklist: blocklist.raiBlocklistName,
 *   pattern: "project-[a-z]+",
 *   isRegex: true,
 * });
 * ```
 *
 * @resource
 */
export const RaiBlocklistItem = Resource<RaiBlocklistItem>(
  "Azure.CognitiveServices.RaiBlocklistItem",
);

/**
 * Observe an item through the blocklist's item list: GET on a missing item
 * answers HTTP 400 with an empty body (no ARM code to type), while the list
 * returns a typed not-found once the blocklist or account is gone.
 */
const getItem = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  raiBlocklistName: string,
  raiBlocklistItemName: string,
) =>
  orUndefinedIfNotFound(
    cognitiveservices
      .ListRaiBlocklistItems({
        subscriptionId,
        resourceGroupName,
        accountName,
        raiBlocklistName,
      })
      .pipe(
        Effect.flatMap((page) =>
          requireSinglePage("ListRaiBlocklistItems", page),
        ),
      ),
  ).pipe(
    Effect.map((page) =>
      page?.value?.find(
        (item) =>
          item.name?.toLowerCase() === raiBlocklistItemName.toLowerCase(),
      ),
    ),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  raiBlocklist: string,
  name: string,
  item: {
    readonly id?: string;
    readonly properties?: cognitiveservices.RaiBlocklistItemProperties;
    readonly tags?: Record<string, string | undefined>;
  },
): RaiBlocklistItem["Attributes"] => ({
  raiBlocklistItemName: name,
  raiBlocklistItemId: item.id ?? "",
  raiBlocklist,
  account,
  resourceGroup,
  pattern: item.properties?.pattern ?? "",
  isRegex: item.properties?.isRegex ?? false,
  tags: userTags(item.tags),
});

export const RaiBlocklistItemProvider = () =>
  Provider.succeed(RaiBlocklistItem, {
    stables: [
      "raiBlocklistItemName",
      "raiBlocklistItemId",
      "raiBlocklist",
      "account",
      "resourceGroup",
    ],

    // Items live inside a blocklist; nuke removes them with the account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.account, output.account) ||
        !sameArm(news.raiBlocklist, output.raiBlocklist) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.raiBlocklistItemName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      const raiBlocklist = output?.raiBlocklist ?? olds?.raiBlocklist;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        raiBlocklist === undefined
      ) {
        return undefined;
      }
      const name =
        output?.raiBlocklistItemName ??
        olds?.name ??
        (yield* createChildName(id));
      const observed = yield* getItem(
        subscriptionId,
        resourceGroup,
        account,
        raiBlocklist,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        account,
        raiBlocklist,
        name,
        observed,
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const { resourceGroup, account, raiBlocklist } = news;
      const name =
        news.name ??
        output?.raiBlocklistItemName ??
        (yield* createChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const isRegex = news.isRegex ?? false;
      const get = getItem(
        subscriptionId,
        resourceGroup,
        account,
        raiBlocklist,
        name,
      );

      // Observe; the PUT is a synchronous upsert sent only on a delta.
      const observed = yield* get;
      if (
        observed === undefined ||
        observed.properties?.pattern !== news.pattern ||
        (observed.properties?.isRegex ?? false) !== isRegex ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* cognitiveservices
          .RaiBlocklistItemsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            raiBlocklistName: raiBlocklist,
            raiBlocklistItemName: name,
            properties: { pattern: news.pattern, isRegex },
            tags,
          })
          .pipe(Effect.retry(whileAccountBusy));
      }
      const fresh = yield* waitForProvisioned(
        `rai blocklist item ${name}`,
        get,
        () => undefined,
        CHILD_BUDGET,
      );
      return toAttrs(resourceGroup, account, raiBlocklist, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cognitiveservices
          .DeleteRaiBlocklistItem({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            raiBlocklistName: output.raiBlocklist,
            raiBlocklistItemName: output.raiBlocklistItemName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `rai blocklist item ${output.raiBlocklistItemName}`,
        getItem(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.raiBlocklist,
          output.raiBlocklistItemName,
        ),
        CHILD_BUDGET,
      );
    }),
  });
