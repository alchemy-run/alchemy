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
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isAccountOwnedByStack } from "./Account.ts";
import { sameArm, whileAccountBusy } from "./Common.ts";

/** The only Defender for AI settings object an account has. */
const SETTING_NAME = "Default";

export interface DefenderForAISettingProps {
  /** Resource group of the account. Changing it replaces the setting. */
  resourceGroup: string;
  /** Account the setting belongs to. Changing it replaces the setting. */
  account: string;
  /**
   * Whether Microsoft Defender for AI threat protection is on for the
   * account. Enabling it bills Defender for AI per processed token.
   */
  state: "Enabled" | "Disabled";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface DefenderForAISetting extends Resource<
  "Azure.CognitiveServices.DefenderForAISetting",
  DefenderForAISettingProps,
  {
    /** ARM resource ID of the setting. */
    defenderForAISettingId: string;
    /** Account the setting belongs to. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Current state. */
    state: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * Microsoft Defender for AI threat protection on one Azure AI services
 * account (`Microsoft.CognitiveServices/accounts/defenderForAISettings/Default`).
 *
 * Every account has exactly one setting, so this resource manages it in
 * place: creating it applies `state`, and deleting it switches protection
 * back to `Disabled` (the API has no delete).
 *
 * @see https://learn.microsoft.com/azure/defender-for-cloud/ai-threat-protection
 *
 * ### Enabling Threat Protection
 * **Example:** Turn on Defender for AI for an account
 * ```typescript
 * yield* Azure.CognitiveServices.DefenderForAISetting("defender", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   state: "Enabled",
 * });
 * ```
 *
 * @resource
 */
export const DefenderForAISetting = Resource<DefenderForAISetting>(
  "Azure.CognitiveServices.DefenderForAISetting",
);

const getSetting = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetDefenderForAISettings({
      subscriptionId,
      resourceGroupName,
      accountName,
      defenderForAISettingName: SETTING_NAME,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  setting: cognitiveservices.GetDefenderForAISettingsResponse,
): DefenderForAISetting["Attributes"] => ({
  defenderForAISettingId: setting.id ?? "",
  account,
  resourceGroup,
  state: setting.properties?.state ?? "Disabled",
  tags: userTags(setting.tags),
});

export const DefenderForAISettingProvider = () =>
  Provider.succeed(DefenderForAISetting, {
    stables: ["defenderForAISettingId", "account", "resourceGroup"],

    // A per-account singleton; it disappears with the account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.account, output.account)
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
      const observed = yield* getSetting(
        subscriptionId,
        resourceGroup,
        account,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, observed);
      // Every account has the setting from birth, untagged; an account
      // owned by this stack makes its setting ours too.
      return (yield* isOwned(id, observed.tags)) ||
        (yield* isAccountOwnedByStack(subscriptionId, resourceGroup, account))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const { resourceGroup, account } = news;
      const tags = yield* desiredTags(id, news.tags);

      // Observe the account's singleton setting; PUT only on a delta.
      const observed = yield* getSetting(
        subscriptionId,
        resourceGroup,
        account,
      );
      if (
        observed === undefined ||
        observed.properties?.state !== news.state ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* cognitiveservices
          .DefenderForAISettingsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            defenderForAISettingName: SETTING_NAME,
            properties: { state: news.state },
            tags,
          })
          .pipe(Effect.retry(whileAccountBusy));
      }
      const fresh = yield* getSetting(subscriptionId, resourceGroup, account);
      return toAttrs(
        resourceGroup,
        account,
        fresh ?? { properties: { state: news.state }, tags },
      );
    }),

    // No DELETE API: switch protection off and drop the tags.
    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cognitiveservices
          .DefenderForAISettingsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            defenderForAISettingName: SETTING_NAME,
            properties: { state: "Disabled" },
            tags: {},
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
    }),
  });
