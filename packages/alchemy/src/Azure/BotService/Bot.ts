import * as botservice from "@distilled.cloud/azure/botservice";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { DEFAULT_BOT_LOCATION, isSubset, reveal, sameArm } from "./Common.ts";

export type BotKind = "azurebot" | "bot" | "designer" | "function" | "sdk";
export type BotSku = "F0" | "S1";
export type BotMsaAppType = "UserAssignedMSI" | "SingleTenant" | "MultiTenant";

export interface BotProps {
  /** Resource group the bot is created in. Changing it replaces the bot. */
  resourceGroup: string;
  /**
   * Bot handle: 4-42 letters, digits, `-`, `_`, and `.`, globally unique
   * across Azure. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the bot.
   */
  name?: string;
  /**
   * Location of the bot: `global`, or a data-residency region (`westeurope`,
   * `centralindia`). Changing it replaces the bot.
   * @default "global"
   */
  location?: string;
  /**
   * Kind of bot. Changing it replaces the bot.
   * @default "azurebot"
   */
  kind?: BotKind;
  /**
   * Pricing tier: `F0` (free, 10k premium-channel messages/month) or `S1`.
   * @default "F0"
   */
  sku?: BotSku;
  /**
   * Display name of the bot.
   * @default the bot name
   */
  displayName?: string;
  /** Description of the bot. */
  description?: string;
  /** URL of the bot's icon. */
  iconUrl?: string;
  /**
   * Messaging endpoint the Bot Framework posts activities to, e.g.
   * `https://example.com/api/messages`. Empty leaves the bot without an
   * endpoint.
   * @default ""
   */
  endpoint?: string;
  /**
   * How the bot authenticates. MultiTenant bot creation is deprecated by
   * Microsoft. Changing it replaces the bot.
   * @default "UserAssignedMSI"
   */
  msaAppType?: BotMsaAppType;
  /**
   * Microsoft App ID of the bot: the client ID of the user-assigned
   * managed identity (`UserAssignedMSI`) or of the Entra app registration.
   * Changing it replaces the bot.
   */
  msaAppId: string;
  /**
   * Tenant of the bot's app/identity. Required for `UserAssignedMSI` and
   * `SingleTenant`. Changing it replaces the bot.
   * @default the subscription's tenant for `UserAssignedMSI`/`SingleTenant`
   */
  msaAppTenantId?: string;
  /**
   * ARM resource ID of the user-assigned managed identity
   * (`UserAssignedMSI` only). Changing it replaces the bot.
   */
  msaAppMSIResourceId?: string;
  /** Application Insights instrumentation key for bot analytics. */
  developerAppInsightKey?: string;
  /** Application Insights API key for bot analytics. */
  developerAppInsightsApiKey?: Redacted.Redacted<string>;
  /** Application Insights application ID for bot analytics. */
  developerAppInsightsApplicationId?: string;
  /** LUIS app IDs used by the bot. */
  luisAppIds?: string[];
  /** LUIS key. */
  luisKey?: Redacted.Redacted<string>;
  /** Whether customer-managed key encryption is enabled. */
  isCmekEnabled?: boolean;
  /** Key Vault key URL used for customer-managed key encryption. */
  cmekKeyVaultUrl?: string;
  /**
   * Whether the bot is reachable from public networks.
   * @default "Enabled"
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Opt out of local authentication so that only managed identity and Entra
   * ID can authenticate.
   */
  disableLocalAuth?: boolean;
  /** Whether the bot supports streaming (Direct Line App Service extension). */
  isStreamingSupported?: boolean;
  /** Channel schema transformation version, e.g. `1.3`. */
  schemaTransformationVersion?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Bot extends Resource<
  "Azure.BotService.Bot",
  BotProps,
  {
    /** Name (handle) of the bot. */
    botName: string;
    /** ARM resource ID of the bot. */
    botId: string;
    /** Resource group that holds the bot. */
    resourceGroup: string;
    /** Location of the bot. */
    location: string;
    /** Kind of bot. */
    kind: string;
    /** Pricing tier. */
    sku: string;
    /** Display name of the bot. */
    displayName: string;
    /** Messaging endpoint. */
    endpoint: string;
    /** Microsoft App type. */
    msaAppType: string;
    /** Microsoft App ID. */
    msaAppId: string;
    /** Tenant of the bot's app/identity. */
    msaAppTenantId: string | undefined;
    /** Managed identity resource ID (`UserAssignedMSI`). */
    msaAppMSIResourceId: string | undefined;
    /** Channels configured for the bot. */
    configuredChannels: string[];
    /** Channels enabled for the bot. */
    enabledChannels: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Bot — a Bot Framework registration that connects a bot's
 * messaging endpoint to channels (Web Chat, Direct Line, Teams, Slack, ...).
 *
 * The bot authenticates as a user-assigned managed identity by default.
 *
 * @see https://learn.microsoft.com/azure/bot-service/abs-quickstart
 *
 * ### Creating a Bot
 * **Example:** Bot authenticating as a managed identity
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("bots");
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("bot-id", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const bot = yield* Azure.BotService.Bot("support", {
 *   resourceGroup: group.resourceGroupName,
 *   msaAppId: identity.clientId,
 *   msaAppTenantId: identity.tenantId,
 *   msaAppMSIResourceId: identity.identityId,
 *   endpoint: "https://support.example.com/api/messages",
 * });
 * ```
 *
 * ### Configuring the Bot
 * **Example:** Display name, description, and Standard tier
 * ```typescript
 * const bot = yield* Azure.BotService.Bot("support", {
 *   resourceGroup: group.resourceGroupName,
 *   msaAppId: identity.clientId,
 *   msaAppMSIResourceId: identity.identityId,
 *   displayName: "Support Bot",
 *   description: "Answers customer questions",
 *   sku: "S1",
 *   tags: { team: "support" },
 * });
 * ```
 *
 * @resource
 */
export const Bot = Resource<Bot>("Azure.BotService.Bot");

const createBotName = (id: string) => createPhysicalName({ id, maxLength: 42 });

const getBot = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
) =>
  orUndefinedIfNotFound(
    botservice.GetBot({ subscriptionId, resourceGroupName, resourceName }),
  );

type ObservedBot = botservice.GetBotResponse | botservice.Bot;

const toAttrs = (
  resourceGroup: string,
  name: string,
  bot: ObservedBot,
): Bot["Attributes"] => ({
  botName: name,
  botId: bot.id ?? "",
  resourceGroup,
  location: bot.location ?? DEFAULT_BOT_LOCATION,
  kind: bot.kind ?? "azurebot",
  sku: bot.sku?.name ?? "F0",
  displayName: bot.properties?.displayName ?? "",
  endpoint: bot.properties?.endpoint ?? "",
  msaAppType: bot.properties?.msaAppType ?? "",
  msaAppId: bot.properties?.msaAppId ?? "",
  msaAppTenantId: bot.properties?.msaAppTenantId || undefined,
  msaAppMSIResourceId: bot.properties?.msaAppMSIResourceId || undefined,
  configuredChannels: [...(bot.properties?.configuredChannels ?? [])],
  enabledChannels: [...(bot.properties?.enabledChannels ?? [])],
  tags: userTags(bot.tags),
});

export const BotProvider = () =>
  Provider.succeed(Bot, {
    stables: ["botName", "botId", "resourceGroup", "location", "kind"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* botservice
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
      const changed = (
        desired: string | undefined,
        actual: string | undefined,
      ) => desired !== undefined && !sameArm(desired, actual);
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        changed(news.name, output.botName) ||
        !sameArm(news.location ?? DEFAULT_BOT_LOCATION, output.location) ||
        !sameArm(news.kind ?? "azurebot", output.kind) ||
        !sameArm(news.msaAppType ?? "UserAssignedMSI", output.msaAppType) ||
        !sameArm(news.msaAppId, output.msaAppId) ||
        changed(news.msaAppTenantId, output.msaAppTenantId) ||
        changed(news.msaAppMSIResourceId, output.msaAppMSIResourceId)
      ) {
        // An app ID can back only one bot ("MsaAppId is already in use"),
        // so a replacement keeping the app ID must delete the old bot first.
        return {
          action: "replace",
          deleteFirst: sameArm(news.msaAppId, output.msaAppId),
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.botName ?? olds?.name ?? (yield* createBotName(id));
      const observed = yield* getBot(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.BotService");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.botName ?? (yield* createBotName(id));
      const location = news.location ?? DEFAULT_BOT_LOCATION;
      const tags = yield* desiredTags(id, news.tags);
      const sku = news.sku ?? "F0";
      const msaAppType = news.msaAppType ?? "UserAssignedMSI";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: name,
      };

      // Mutable, non-secret settings compared against the observed bot.
      const settings = {
        displayName: news.displayName ?? name,
        endpoint: news.endpoint ?? "",
        description: news.description,
        iconUrl: news.iconUrl,
        developerAppInsightKey: news.developerAppInsightKey,
        developerAppInsightsApplicationId:
          news.developerAppInsightsApplicationId,
        luisAppIds: news.luisAppIds,
        isCmekEnabled: news.isCmekEnabled,
        cmekKeyVaultUrl: news.cmekKeyVaultUrl,
        publicNetworkAccess: news.publicNetworkAccess,
        disableLocalAuth: news.disableLocalAuth,
        isStreamingSupported: news.isStreamingSupported,
        schemaTransformationVersion: news.schemaTransformationVersion,
      };
      // Secrets are write-only (GET masks them): previous props are the
      // only hint of what is deployed.
      const appInsightsApiKey = reveal(news.developerAppInsightsApiKey);
      const luisKey = reveal(news.luisKey);

      // Observe.
      let observed: ObservedBot | undefined = yield* getBot(
        subscriptionId,
        resourceGroup,
        name,
      );

      // Ensure. Bot creation is synchronous.
      if (observed === undefined) {
        const msaAppTenantId =
          news.msaAppTenantId ??
          (msaAppType === "MultiTenant" ? undefined : env.tenantId);
        observed = yield* botservice.CreateBot({
          ...where,
          location,
          kind: news.kind ?? "azurebot",
          sku: { name: sku },
          tags,
          properties: {
            ...settings,
            msaAppType,
            msaAppId: news.msaAppId,
            msaAppTenantId,
            msaAppMSIResourceId: news.msaAppMSIResourceId,
            developerAppInsightsApiKey: appInsightsApiKey,
            luisKey,
          },
        });
      } else {
        // Sync: PATCH only the observed deltas.
        const current = observed.properties;
        const delta: Partial<botservice.BotPropertiesInput> = {};
        for (const [key, value] of Object.entries(settings)) {
          if (
            !isSubset(
              value,
              current?.[key as keyof typeof current] ?? undefined,
            )
          ) {
            (delta as Record<string, unknown>)[key] = value;
          }
        }
        if (appInsightsApiKey !== reveal(olds?.developerAppInsightsApiKey)) {
          delta.developerAppInsightsApiKey = appInsightsApiKey;
        }
        if (luisKey !== reveal(olds?.luisKey)) delta.luisKey = luisKey;
        const skuChanged = observed.sku?.name !== sku;
        const tagsChanged = tagsDiffer(observed.tags, tags);
        const propsChanged = Object.keys(delta).length > 0;
        if (skuChanged || tagsChanged || propsChanged) {
          observed = yield* botservice.UpdateBot({
            ...where,
            sku: skuChanged ? { name: sku } : undefined,
            tags: tagsChanged ? tags : undefined,
            properties: propsChanged
              ? {
                  ...delta,
                  // Required by the PATCH schema.
                  displayName: settings.displayName,
                  endpoint: settings.endpoint,
                  msaAppId: current?.msaAppId ?? news.msaAppId,
                }
              : undefined,
          });
        }
      }

      const fresh =
        (yield* getBot(subscriptionId, resourceGroup, name)) ?? observed;
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        botservice.DeleteBot({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          resourceName: output.botName,
        }),
      );
      yield* waitUntilGone(
        `bot ${output.botName}`,
        getBot(subscriptionId, output.resourceGroup, output.botName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
