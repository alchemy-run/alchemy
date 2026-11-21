import * as discord from "@distilled.cloud/discord/discord";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { botUserId, listBotGuilds, ownership, physicalName } from "./internal/Discord.ts";
import type { Providers } from "./Providers.ts";

export interface WebhookProps {
  /** Channel the webhook posts into. Changing it moves the webhook. */
  channelId: string;
  /**
   * Default username of the webhook's messages, 1-80 characters. Discord
   * rejects names containing "discord" or "clyde".
   * @default a name generated from the app, stage and logical id
   */
  name?: string;
  /**
   * Default avatar, as a data URI (`data:image/png;base64,...`). Sent when it
   * changes from the last deploy.
   */
  avatar?: string;
}

export interface WebhookAttributes {
  /** Webhook id (a snowflake). */
  webhookId: string;
  /** Channel the webhook posts into. */
  channelId: string;
  /** Guild of the channel. */
  guildId: string | undefined;
  /** Webhook name. */
  name: string;
  /** Avatar hash, if one is set. */
  avatarHash: string | undefined;
  /** The secret token; anyone holding it can post as the webhook. */
  token: Redacted.Redacted<string>;
  /** `https://discord.com/api/webhooks/{id}/{token}`, the execute URL. */
  url: Redacted.Redacted<string>;
}

/**
 * An incoming webhook on a guild channel. Anything holding its URL can post
 * messages into the channel, without a bot token.
 *
 * The bot needs `MANAGE_WEBHOOKS` in the channel. A webhook belongs to the
 * stack when the bot created it (Discord records the creator on the
 * webhook). The token and URL are secrets and come back `Redacted`.
 *
 * ### Creating Webhooks
 * **Example:** Deploy notifications webhook
 * ```typescript
 * const deploys = yield* Discord.Channel("Deploys", { guildId, name: "deploys" });
 * const hook = yield* Discord.Webhook("DeployHook", {
 *   channelId: deploys.channelId,
 *   name: "Deploy Bot",
 * });
 * ```
 *
 * ### Posting Through a Webhook
 * **Example:** Execute the webhook from a Worker
 * ```typescript
 * // in a Worker's construction phase
 * const post = yield* Discord.ExecuteWebhook(hook);
 * // per request
 * yield* post({ body: { content: "Deployed v1.2.3" } });
 * ```
 *
 * **Example:** Pass the URL to another service
 * ```typescript
 * yield* Cloudflare.Worker("Notifier", {
 *   main: "./src/notifier.ts",
 *   env: { DISCORD_WEBHOOK_URL: hook.url },
 * });
 * ```
 *
 * @resource
 * @product Webhook
 */
export interface Webhook extends Resource<
  "Discord.Webhook",
  WebhookProps,
  WebhookAttributes,
  never,
  Providers
> {}

export const Webhook = Resource<Webhook>("Discord.Webhook");

/** Discord answered a webhook create without the token incoming webhooks carry. */
export class WebhookTokenMissing extends Data.TaggedError("Discord.WebhookTokenMissing")<{
  readonly webhookId: string;
}> {}

type AnyWebhook = discord.GetWebhookResponseBody;

const redacted = (value: string | Redacted.Redacted<string>) =>
  typeof value === "string" ? Redacted.make(value) : value;

const toAttributes = (hook: AnyWebhook): WebhookAttributes | undefined => {
  if (!("token" in hook) || hook.token === undefined || hook.channel_id === null) return undefined;
  const token = redacted(hook.token);
  return {
    webhookId: hook.id,
    channelId: hook.channel_id,
    guildId: hook.guild_id ?? undefined,
    name: hook.name,
    avatarHash: hook.avatar ?? undefined,
    token,
    url: Redacted.make(`https://discord.com/api/webhooks/${hook.id}/${Redacted.value(token)}`),
  };
};

const getWebhook = (webhookId: string) =>
  discord
    .getWebhook({ webhook_id: webhookId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const nameFor = (id: string, instanceId: string, props: { name?: string }) =>
  props.name !== undefined
    ? Effect.succeed(props.name)
    : physicalName(id, { instanceId, maxLength: 80 });

const isBotWebhook = (hook: AnyWebhook, botId: string) =>
  hook.type === 1 && "user" in hook && hook.user?.id === botId;

export const WebhookProvider = () =>
  Provider.succeed(Webhook, {
    stables: ["webhookId", "token", "url"],

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      if (output !== undefined) {
        const hook = yield* getWebhook(output.webhookId);
        return hook ? toAttributes(hook) : undefined;
      }
      if (olds?.channelId === undefined) return undefined;
      const name = yield* nameFor(id, instanceId, olds);
      const hooks = (yield* discord.listChannelWebhooks({ channel_id: olds.channelId })) ?? [];
      const match = hooks.find((h) => h.name === name && h.type === 1);
      const attrs = match ? toAttributes(match) : undefined;
      if (match === undefined || attrs === undefined) return undefined;
      return ownership(attrs, isBotWebhook(match, yield* botUserId()));
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
      const name =
        news.name === undefined && output?.name !== undefined
          ? output.name
          : yield* nameFor(id, instanceId, news);

      // Observe
      const observed = output ? yield* getWebhook(output.webhookId) : undefined;

      // Ensure
      if (observed === undefined) {
        const created = yield* discord.createWebhook({
          channel_id: news.channelId,
          name,
          avatar: news.avatar,
        });
        const attrs = toAttributes(created);
        if (attrs === undefined) {
          return yield* new WebhookTokenMissing({ webhookId: created.id });
        }
        return attrs;
      }

      // Sync
      const body: Omit<discord.UpdateWebhookRequest, "webhook_id"> = {};
      if (observed.name !== name) body.name = name;
      if (observed.channel_id !== news.channelId) body.channel_id = news.channelId;
      if (news.avatar !== olds?.avatar) body.avatar = news.avatar ?? null;
      if (Object.keys(body).length > 0) {
        yield* discord.updateWebhook({ webhook_id: observed.id, ...body });
      }
      const hook = (yield* getWebhook(observed.id)) ?? observed;
      return toAttributes(hook) ?? output!;
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discord
        .deleteWebhook({ webhook_id: output.webhookId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: Effect.fn(function* () {
      const botId = yield* botUserId();
      const guilds = yield* listBotGuilds();
      const rows = yield* Effect.forEach(
        guilds,
        (guild) =>
          discord.getGuildWebhooks({ guild_id: guild.id }).pipe(
            Effect.map((hooks) =>
              (hooks ?? [])
                .filter((h) => isBotWebhook(h, botId))
                .map(toAttributes)
                .filter((a): a is WebhookAttributes => a !== undefined),
            ),
            // The bot left the guild while listing.
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          ),
        { concurrency: 4 },
      );
      return rows.flat();
    }),
  });
