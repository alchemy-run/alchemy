import * as botservice from "@distilled.cloud/azure/botservice";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  botOwnedByStack,
  DEFAULT_BOT_LOCATION,
  isSubset,
  sameArm,
} from "./Common.ts";

export type ChannelName =
  | "AlexaChannel"
  | "FacebookChannel"
  | "EmailChannel"
  | "KikChannel"
  | "TelegramChannel"
  | "SlackChannel"
  | "MsTeamsChannel"
  | "SkypeChannel"
  | "WebChatChannel"
  | "DirectLineChannel"
  | "SmsChannel"
  | "LineChannel"
  | "DirectLineSpeechChannel"
  | "OutlookChannel"
  | "Omnichannel"
  | "TelephonyChannel"
  | "AcsChatChannel"
  | "SearchAssistant"
  | "M365Extensions";

/** A Direct Line / Web Chat site. */
export interface ChannelSite {
  /** Name of the site. */
  siteName: string;
  /** Whether the site is enabled. */
  isEnabled: boolean;
  /** Whether the site accepts the Bot Framework V3 protocol. */
  isV3Enabled?: boolean;
  /** Whether enhanced authentication (trusted origins) is enabled. */
  isSecureSiteEnabled?: boolean;
  /** Trusted origin URLs (requires `isSecureSiteEnabled`). */
  trustedOrigins?: string[];
  /** Whether Web Chat speech is enabled. */
  isWebChatSpeechEnabled?: boolean;
  /** Whether preview versions of Web Chat are enabled. */
  isWebchatPreviewEnabled?: boolean;
  /** Whether users are blocked from uploading files. */
  isBlockUserUploadEnabled?: boolean;
}

export interface ChannelProps {
  /** Resource group of the bot. Changing it replaces the channel. */
  resourceGroup: string;
  /** Name of the bot the channel belongs to. Changing it replaces the channel. */
  bot: string;
  /**
   * Channel type; it is also the channel's resource name, so a bot has at
   * most one channel of each type. Changing it replaces the channel.
   */
  channelName: ChannelName;
  /**
   * Channel-specific properties, as documented for the channel type. For
   * `DirectLineChannel` and `WebChatChannel` this is `{ sites: [...] }`
   * (see {@link ChannelSite}); third-party channels take their app
   * credentials (e.g. Slack `clientId`/`clientSecret`, Telegram
   * `accessToken`, Teams `isEnabled`).
   */
  properties?: { sites?: ChannelSite[] } & Record<string, unknown>;
  /**
   * Location of the channel; must match the bot's. Changing it replaces the
   * channel.
   * @default "global"
   */
  location?: string;
}

/** Keys of a Direct Line / Web Chat site. */
export interface ChannelSiteKeys {
  /** Name of the site. */
  siteName: string;
  /** ID of the site. */
  siteId: string | undefined;
  /** Primary secret key of the site. */
  key: Redacted.Redacted<string> | undefined;
  /** Secondary secret key of the site. */
  key2: Redacted.Redacted<string> | undefined;
}

export interface Channel extends Resource<
  "Azure.BotService.Channel",
  ChannelProps,
  {
    /** Channel type (also the resource name). */
    channelName: string;
    /** ARM resource ID of the channel. */
    channelId: string;
    /** Name of the bot. */
    bot: string;
    /** Resource group of the bot. */
    resourceGroup: string;
    /** Location of the channel. */
    location: string;
    /**
     * Channel-specific properties as returned by Azure (secrets such as
     * site keys are masked; see `siteKeys`).
     */
    properties: Record<string, unknown>;
    /** Direct Line / Web Chat site keys (empty for other channel types). */
    siteKeys: ChannelSiteKeys[];
  },
  never,
  Providers
> {}

/**
 * A channel of an Azure Bot — connects the bot to a client surface such as
 * Direct Line, Web Chat, Microsoft Teams, Slack, or Telegram.
 *
 * Every bot gets `WebChatChannel` and `DirectLineChannel` automatically;
 * declaring one adopts and configures the existing channel.
 *
 * Channels cannot be tagged: a channel is owned by whoever owns its bot.
 *
 * @see https://learn.microsoft.com/azure/bot-service/bot-service-manage-channels
 *
 * ### Direct Line
 * **Example:** Direct Line channel with one site
 * ```typescript
 * const directLine = yield* Azure.BotService.Channel("direct-line", {
 *   resourceGroup: group.resourceGroupName,
 *   bot: bot.botName,
 *   channelName: "DirectLineChannel",
 *   properties: {
 *     sites: [
 *       { siteName: "app", isEnabled: true, isV3Enabled: true },
 *     ],
 *   },
 * });
 * // directLine.siteKeys[0].key is the Direct Line secret.
 * ```
 *
 * ### Third-Party Channels
 * **Example:** Microsoft Teams
 * ```typescript
 * yield* Azure.BotService.Channel("teams", {
 *   resourceGroup: group.resourceGroupName,
 *   bot: bot.botName,
 *   channelName: "MsTeamsChannel",
 *   properties: { isEnabled: true, enableCalling: false },
 * });
 * ```
 *
 * @resource
 */
export const Channel = Resource<Channel>("Azure.BotService.Channel");

const SITE_CHANNELS = new Set(["DirectLineChannel", "WebChatChannel"]);

const getChannel = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  channelName: string,
) =>
  orUndefinedIfNotFound(
    botservice.GetChannel({
      subscriptionId,
      resourceGroupName,
      resourceName,
      channelName,
    }),
  );

const getSiteKeys = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  channelName: string,
) =>
  SITE_CHANNELS.has(channelName)
    ? orUndefinedIfNotFound(
        botservice.ListChannelWithKeys({
          subscriptionId,
          resourceGroupName,
          resourceName,
          channelName: channelName as "DirectLineChannel" | "WebChatChannel",
        }),
      ).pipe(
        Effect.map((res): ChannelSiteKeys[] =>
          (res?.setting?.sites ?? []).map((site) => ({
            siteName: site.siteName,
            siteId: site.siteId,
            key: site.key ? Redacted.make(site.key) : undefined,
            key2: site.key2 ? Redacted.make(site.key2) : undefined,
          })),
        ),
      )
    : Effect.succeed([] as ChannelSiteKeys[]);

type ObservedChannel = botservice.GetChannelResponse | botservice.BotChannel;

const propertiesOf = (channel: ObservedChannel | undefined) =>
  (channel?.properties?.properties ?? {}) as Record<string, unknown>;

/**
 * Sites are matched by name; the observed site's `siteId` is sent back so
 * Azure updates it in place instead of creating a new site.
 */
const withSiteIds = (
  desired: Record<string, unknown>,
  observed: Record<string, unknown>,
) => {
  const sites = desired.sites as ChannelSite[] | undefined;
  if (sites === undefined) return desired;
  const observedSites = (observed.sites ?? []) as Array<{
    siteName?: string;
    siteId?: string;
  }>;
  return {
    ...desired,
    sites: sites.map((site) => {
      const match = observedSites.find((o) => o.siteName === site.siteName);
      return match?.siteId ? { ...site, siteId: match.siteId } : site;
    }),
  };
};

/**
 * Whether the observed channel has converged to the desired properties.
 * Sites compare by name, order-insensitively.
 */
const propertiesMatch = (
  desired: Record<string, unknown>,
  observed: Record<string, unknown>,
) => {
  const { sites, ...rest } = desired as { sites?: ChannelSite[] };
  if (!isSubset(rest, observed)) return false;
  if (sites === undefined) return true;
  const observedSites = (observed.sites ?? []) as Array<{ siteName?: string }>;
  return (
    observedSites.length === sites.length &&
    sites.every((site) =>
      isSubset(
        site,
        observedSites.find((o) => o.siteName === site.siteName),
      ),
    )
  );
};

const toAttrs = (
  resourceGroup: string,
  bot: string,
  channelName: string,
  channel: ObservedChannel,
  siteKeys: ChannelSiteKeys[],
): Channel["Attributes"] => ({
  channelName,
  channelId: channel.id ?? "",
  bot,
  resourceGroup,
  location: channel.location ?? DEFAULT_BOT_LOCATION,
  properties: propertiesOf(channel),
  siteKeys,
});

export const ChannelProvider = () =>
  Provider.succeed(Channel, {
    stables: ["channelName", "channelId", "bot", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const bots = yield* botservice
        .ListBots({ subscriptionId })
        .pipe(Effect.flatMap((page) => requireSinglePage("ListBots", page)));
      const found: Channel["Attributes"][] = [];
      for (const bot of bots.value ?? []) {
        const group = resourceGroupOf(bot.id);
        if (group === undefined || bot.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          botservice.ListChannelByResourceGroup({
            subscriptionId,
            resourceGroupName: group,
            resourceName: bot.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage("ListChannelByResourceGroup", page);
        }
        for (const channel of page?.value ?? []) {
          const channelName = channel.properties?.channelName ?? channel.name;
          if (hasAnyAlchemyTag(bot.tags) && channelName !== undefined) {
            found.push(toAttrs(group, bot.name, channelName, channel, []));
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.bot, output.bot) ||
        news.channelName !== output.channelName ||
        !sameArm(news.location ?? DEFAULT_BOT_LOCATION, output.location)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const bot = output?.bot ?? olds?.bot;
      const channelName = output?.channelName ?? olds?.channelName;
      if (
        resourceGroup === undefined ||
        bot === undefined ||
        channelName === undefined
      ) {
        return undefined;
      }
      const observed = yield* getChannel(
        subscriptionId,
        resourceGroup,
        bot,
        channelName,
      );
      if (observed === undefined) return undefined;
      const siteKeys = yield* getSiteKeys(
        subscriptionId,
        resourceGroup,
        bot,
        channelName,
      );
      const attrs = toAttrs(
        resourceGroup,
        bot,
        channelName,
        observed,
        siteKeys,
      );
      return (yield* botOwnedByStack(subscriptionId, resourceGroup, bot))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.BotService");
      const { resourceGroup, bot, channelName } = news;
      const location = news.location ?? DEFAULT_BOT_LOCATION;
      const desired = (news.properties ?? {}) as Record<string, unknown>;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: bot,
        channelName,
      };
      const get = getChannel(subscriptionId, resourceGroup, bot, channelName);

      // Observe.
      let observed = yield* get;

      // Ensure. Channel creation is synchronous.
      if (observed === undefined) {
        observed = yield* botservice.CreateChannel({
          ...where,
          location,
          properties: { channelName, location, properties: desired },
        });
      }

      // Sync properties against the observed channel. Sites are matched by
      // name; a site added by an update gets its `siteId` only afterwards,
      // so re-observe and repeat (bounded).
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = propertiesOf(observed);
        if (propertiesMatch(desired, current)) break;
        yield* botservice.UpdateChannel({
          ...where,
          location,
          properties: {
            channelName,
            location,
            properties: withSiteIds(desired, current),
          },
        });
        observed = (yield* get) ?? observed;
      }

      const fresh = (yield* get) ?? observed;
      const siteKeys = yield* getSiteKeys(
        subscriptionId,
        resourceGroup,
        bot,
        channelName,
      );
      return toAttrs(resourceGroup, bot, channelName, fresh, siteKeys);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        botservice.DeleteChannel({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          resourceName: output.bot,
          channelName: output.channelName,
        }),
      );
      yield* waitUntilGone(
        `bot channel ${output.bot}/${output.channelName}`,
        getChannel(
          subscriptionId,
          output.resourceGroup,
          output.bot,
          output.channelName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.BotService.Bot", "Azure.Resources.ResourceGroup"],
    },
  });
