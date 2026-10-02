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

export interface RaiBlocklistProps {
  /** Resource group of the account. Changing it replaces the blocklist. */
  resourceGroup: string;
  /**
   * Account (kind `OpenAI` or `AIServices`) that holds the blocklist.
   * Changing it replaces the blocklist.
   */
  account: string;
  /**
   * Blocklist name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the blocklist.
   */
  name?: string;
  /**
   * Description of the blocklist.
   * @default ""
   */
  description?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface RaiBlocklist extends Resource<
  "Azure.CognitiveServices.RaiBlocklist",
  RaiBlocklistProps,
  {
    /** Name of the blocklist; reference it from `RaiPolicy.customBlocklists`. */
    raiBlocklistName: string;
    /** ARM resource ID of the blocklist. */
    raiBlocklistId: string;
    /** Account that holds the blocklist. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Description of the blocklist. */
    description: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A custom content-filter blocklist
 * (`Microsoft.CognitiveServices/accounts/raiBlocklists`) of terms or
 * regular expressions that Azure OpenAI / Foundry models block. Add terms
 * with `CognitiveServices.RaiBlocklistItem` and attach the blocklist to a
 * `CognitiveServices.RaiPolicy`.
 *
 * @see https://learn.microsoft.com/azure/ai-foundry/openai/how-to/use-blocklists
 *
 * ### Creating a Blocklist
 * **Example:** Blocklist with one regex item
 * ```typescript
 * const blocklist = yield* Azure.CognitiveServices.RaiBlocklist("terms", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   description: "Internal code names",
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
export const RaiBlocklist = Resource<RaiBlocklist>(
  "Azure.CognitiveServices.RaiBlocklist",
);

export const getRaiBlocklist = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  raiBlocklistName: string,
) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetRaiBlocklist({
      subscriptionId,
      resourceGroupName,
      accountName,
      raiBlocklistName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  blocklist: cognitiveservices.GetRaiBlocklistResponse,
): RaiBlocklist["Attributes"] => ({
  raiBlocklistName: name,
  raiBlocklistId: blocklist.id ?? "",
  account,
  resourceGroup,
  description: blocklist.properties?.description,
  tags: userTags(blocklist.tags),
});

export const RaiBlocklistProvider = () =>
  Provider.succeed(RaiBlocklist, {
    stables: ["raiBlocklistName", "raiBlocklistId", "account", "resourceGroup"],

    // Blocklists live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.account, output.account) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.raiBlocklistName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const name =
        output?.raiBlocklistName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getRaiBlocklist(
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
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const { resourceGroup, account } = news;
      const name =
        news.name ?? output?.raiBlocklistName ?? (yield* createChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getRaiBlocklist(subscriptionId, resourceGroup, account, name);

      // Observe; the PUT is a synchronous upsert, so ensure and sync are
      // one call sent only when something differs.
      const observed = yield* get;
      if (
        observed === undefined ||
        (news.description !== undefined &&
          observed.properties?.description !== news.description) ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* cognitiveservices
          .RaiBlocklistsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            raiBlocklistName: name,
            // Azure answers 500 when the description is missing.
            properties: {
              description:
                news.description ?? observed?.properties?.description ?? "",
            },
            tags,
          })
          .pipe(Effect.retry(whileAccountBusy));
      }
      const fresh = yield* waitForProvisioned(
        `rai blocklist ${name}`,
        get,
        () => undefined,
        CHILD_BUDGET,
      );
      return toAttrs(resourceGroup, account, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cognitiveservices
          .DeleteRaiBlocklist({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            raiBlocklistName: output.raiBlocklistName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `rai blocklist ${output.raiBlocklistName}`,
        getRaiBlocklist(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.raiBlocklistName,
        ),
        CHILD_BUDGET,
      );
    }),
  });
