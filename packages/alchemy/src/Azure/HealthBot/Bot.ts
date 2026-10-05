import * as healthbot from "@distilled.cloud/azure/healthbot";
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

/**
 * Pricing tier of a Health Bot. `F0` is the free tier (limited monthly
 * messages); `C0`/`C1` are paid standard tiers; `PES` is the
 * Patient-Experience tier.
 */
export type BotSku = "F0" | "C0" | "C1" | "PES";

/** Managed identity type of a Health Bot. */
export type BotIdentityType =
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned, UserAssigned"
  | "None";

export interface BotIdentity {
  /** Identity type. `None` removes all identities. */
  type: BotIdentityType;
  /**
   * ARM resource IDs of user-assigned identities to attach (required when
   * `type` includes `UserAssigned`).
   */
  userAssignedIdentities?: string[];
}

export interface BotKeyVaultProperties {
  /** Name of the Key Vault key used for customer-managed encryption. */
  keyName: string;
  /** Version of the key. If omitted, the latest version is used. */
  keyVersion?: string;
  /** URI of the Key Vault, e.g. `https://my-vault.vault.azure.net/`. */
  keyVaultUri: string;
  /**
   * ARM resource ID of the user-assigned identity that has access to the
   * key. If omitted, the bot's system-assigned identity is used.
   */
  userIdentity?: string;
}

export interface BotProps {
  /**
   * Resource group the bot is created in. Changing it replaces the bot.
   */
  resourceGroup: string;
  /**
   * Bot name, 2-64 characters of letters, digits, `_`, `.` and `-`,
   * starting with a letter or digit. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the bot.
   */
  name?: string;
  /**
   * Azure location of the bot. Health Bot is offered in a limited set of
   * regions (e.g. `eastus`, `westus2`, `northeurope`, `westeurope`).
   * Changing it replaces the bot.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Pricing tier. Updated in place.
   * @default "F0"
   */
  sku?: BotSku;
  /**
   * Managed identity of the bot (needed for customer-managed keys). Updated
   * in place. When omitted, the observed identity is left untouched.
   */
  identity?: BotIdentity;
  /**
   * Customer-managed key used to encrypt the bot's data. Updated in place.
   * When omitted, the observed encryption settings are left untouched.
   */
  keyVaultProperties?: BotKeyVaultProperties;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Bot extends Resource<
  "Azure.HealthBot.Bot",
  BotProps,
  {
    /** Name of the bot. */
    botName: string;
    /** Resource group that holds the bot. */
    resourceGroup: string;
    /** ARM resource ID of the bot. */
    botId: string;
    /** Location of the bot. */
    location: string;
    /** Pricing tier of the bot. */
    sku: string;
    /** Link to the bot's management portal. */
    botManagementPortalLink: string | undefined;
    /** Access control method of the bot. */
    accessControlMethod: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Health Bot (Healthcare agent service) — a managed, compliant
 * conversational AI service for building virtual health assistants. The
 * bot's scenarios are authored in its management portal
 * (`botManagementPortalLink`).
 *
 * @see https://learn.microsoft.com/azure/health-bot/
 *
 * ### Creating a Bot
 * **Example:** Free-tier bot
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("health", {
 *   location: "eastus",
 * });
 * const bot = yield* Azure.HealthBot.Bot("assistant", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * // bot.botManagementPortalLink -> "https://us.healthbot.microsoft.com/..."
 * ```
 *
 * **Example:** Standard-tier bot with tags
 * ```typescript
 * const bot = yield* Azure.HealthBot.Bot("assistant", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "C0",
 *   tags: { team: "care" },
 * });
 * ```
 *
 * ### Customer-Managed Keys
 * **Example:** Encrypt with a Key Vault key via a user-assigned identity
 * ```typescript
 * const bot = yield* Azure.HealthBot.Bot("assistant", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "C0",
 *   identity: {
 *     type: "UserAssigned",
 *     userAssignedIdentities: [identity.identityId],
 *   },
 *   keyVaultProperties: {
 *     keyName: "healthbot",
 *     keyVaultUri: "https://my-vault.vault.azure.net/",
 *     userIdentity: identity.identityId,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Bot = Resource<Bot>("Azure.HealthBot.Bot");

type ObservedBot = healthbot.GetBotResponse;

const createBotName = (id: string) =>
  createPhysicalName({ id, maxLength: 64, lowercase: true, delimiter: "-" });

export const getHealthBot = (
  subscriptionId: string,
  resourceGroupName: string,
  botName: string,
) =>
  orUndefinedIfNotFound(
    healthbot.GetBot({ subscriptionId, resourceGroupName, botName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  bot: ObservedBot,
): Bot["Attributes"] => ({
  botName: name,
  resourceGroup,
  botId: bot.id ?? "",
  location: bot.location,
  sku: bot.sku.name,
  botManagementPortalLink: bot.properties?.botManagementPortalLink,
  accessControlMethod: bot.properties?.accessControlMethod,
  principalId: bot.identity?.principalId,
  tags: userTags(bot.tags),
});

const toIdentityInput = (identity: BotIdentity): healthbot.IdentityInput => ({
  type: identity.type,
  userAssignedIdentities:
    identity.userAssignedIdentities &&
    identity.userAssignedIdentities.length > 0
      ? Object.fromEntries(
          identity.userAssignedIdentities.map((uai) => [uai, {}]),
        )
      : undefined,
});

const normalizeType = (type: string | undefined) =>
  (type ?? "None").replace(/\s+/g, "").toLowerCase();

const identityDiffers = (
  observed: healthbot.Identity | undefined,
  desired: BotIdentity,
) => {
  if (normalizeType(observed?.type) !== normalizeType(desired.type)) {
    return true;
  }
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((k) => k.toLowerCase())
    .sort();
  const want = (desired.userAssignedIdentities ?? [])
    .map((k) => k.toLowerCase())
    .sort();
  return have.join("|") !== want.join("|");
};

const keyVaultDiffers = (
  observed: healthbot.KeyVaultProperties | undefined,
  desired: BotKeyVaultProperties,
) =>
  observed === undefined ||
  observed.keyName !== desired.keyName ||
  (desired.keyVersion !== undefined &&
    observed.keyVersion !== desired.keyVersion) ||
  observed.keyVaultUri.replace(/\/$/, "").toLowerCase() !==
    desired.keyVaultUri.replace(/\/$/, "").toLowerCase() ||
  (desired.userIdentity ?? "").toLowerCase() !==
    (observed.userIdentity ?? "").toLowerCase();

export const BotProvider = () =>
  Provider.succeed(Bot, {
    stables: ["botName", "resourceGroup", "botId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* healthbot
        .ListBots({ subscriptionId })
        .pipe(Effect.flatMap((page) => requireSinglePage("ListBots", page)));
      return (page.value ?? []).flatMap((bot) => {
        const group = resourceGroupOf(bot.id);
        return hasAnyAlchemyTag(bot.tags) &&
          group !== undefined &&
          bot.name !== undefined
          ? [toAttrs(group, bot.name, bot)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.botName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.replace(/\s+/g, "").toLowerCase() !==
            output.location.replace(/\s+/g, "").toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.botName ?? olds?.name ?? (yield* createBotName(id));
      const observed = yield* getHealthBot(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.HealthBot");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.botName ?? (yield* createBotName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = news.sku ?? "F0";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        botName: name,
      };
      const label = `health bot ${name}`;
      const get = getHealthBot(subscriptionId, resourceGroup, name);
      const wait = waitForProvisioned(
        label,
        get,
        (bot) => bot.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* healthbot.CreateBot({
          ...where,
          location,
          tags,
          sku: { name: sku },
          identity: news.identity ? toIdentityInput(news.identity) : undefined,
          properties: news.keyVaultProperties
            ? { keyVaultProperties: news.keyVaultProperties }
            : undefined,
        });
      }
      observed = yield* wait;

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const skuChanged = observed.sku.name !== sku;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const identityChanged =
        news.identity !== undefined &&
        identityDiffers(observed.identity, news.identity);
      const keyVaultChanged =
        news.keyVaultProperties !== undefined &&
        keyVaultDiffers(
          observed.properties?.keyVaultProperties,
          news.keyVaultProperties,
        );
      if (skuChanged || tagsChanged || identityChanged || keyVaultChanged) {
        yield* healthbot.UpdateBot({
          ...where,
          sku: skuChanged ? { name: sku } : undefined,
          tags: tagsChanged ? tags : undefined,
          identity:
            identityChanged && news.identity
              ? toIdentityInput(news.identity)
              : undefined,
          properties:
            keyVaultChanged && news.keyVaultProperties
              ? { keyVaultProperties: news.keyVaultProperties }
              : undefined,
        });
        observed = yield* wait;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        healthbot.DeleteBot({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          botName: output.botName,
        }),
      );
      yield* waitUntilGone(
        `health bot ${output.botName}`,
        getHealthBot(subscriptionId, output.resourceGroup, output.botName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
