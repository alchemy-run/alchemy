import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { botUserId, listBotGuilds, ownership, physicalName } from "./internal/Discord.ts";
import type { Providers } from "./Providers.ts";

export interface GuildTemplateProps {
  /** Guild the template snapshots. A guild has at most one template. */
  guildId: string;
  /**
   * Template name, 1-100 characters.
   * @default a name generated from the app, stage and logical id
   */
  name?: string;
  /** Description, up to 120 characters. */
  description?: string;
  /**
   * Re-snapshot the guild's channels, roles and settings on every deploy
   * where they changed since the last snapshot.
   * @default true
   */
  sync?: boolean;
}

export interface GuildTemplateAttributes {
  /** Template code. */
  code: string;
  /** Source guild id. */
  guildId: string;
  /** Template name. */
  name: string;
  /** `https://discord.new/{code}`, which creates a server from the template. */
  url: string;
  /** Whether the guild changed since the last snapshot. */
  isDirty: boolean;
}

/**
 * A guild template: a snapshot of a guild's channels, roles and settings
 * that anyone can use to create a new server.
 *
 * The bot needs `MANAGE_GUILD`. A guild has at most one template. With
 * `sync` on (the default), each deploy re-snapshots the guild when it
 * changed, so the template follows the channels and roles the same stack
 * declares.
 *
 * ### Publishing a Template
 * **Example:** Template of the community server
 * ```typescript
 * const template = yield* Discord.GuildTemplate("Community", {
 *   guildId,
 *   name: "Community starter",
 *   description: "Channels and roles for a new community",
 * });
 * // template.url === "https://discord.new/abc123"
 * ```
 *
 * @resource
 * @product Guild
 */
export interface GuildTemplate extends Resource<
  "Discord.GuildTemplate",
  GuildTemplateProps,
  GuildTemplateAttributes,
  never,
  Providers
> {}

export const GuildTemplate = Resource<GuildTemplate>("Discord.GuildTemplate");

const toAttributes = (t: discord.GuildTemplateResponse): GuildTemplateAttributes => ({
  code: t.code,
  guildId: t.source_guild_id,
  name: t.name,
  url: `https://discord.new/${t.code}`,
  isDirty: t.is_dirty ?? false,
});

const nameFor = (id: string, instanceId: string, props: { name?: string }) =>
  props.name !== undefined
    ? Effect.succeed(props.name)
    : physicalName(id, { instanceId, maxLength: 100 });

const templatesOf = (guildId: string) =>
  discord.listGuildTemplates({ guild_id: guildId }).pipe(Effect.map((t) => t ?? []));

export const GuildTemplateProvider = () =>
  Provider.succeed(GuildTemplate, {
    stables: ["code", "guildId", "url"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || olds === undefined) return;
      if (news.guildId !== (output?.guildId ?? olds.guildId)) return { action: "replace" } as const;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const guildId = output?.guildId ?? olds?.guildId;
      if (guildId === undefined) return undefined;
      const templates = yield* templatesOf(guildId);
      if (output !== undefined) {
        const t = templates.find((x) => x.code === output.code);
        return t ? toAttributes(t) : undefined;
      }
      const t = templates[0];
      if (t === undefined) return undefined;
      return ownership(toAttributes(t), t.creator_id === (yield* botUserId()));
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const name =
        news.name === undefined && output?.name !== undefined
          ? output.name
          : yield* nameFor(id, instanceId, news);
      const templates = yield* templatesOf(news.guildId);
      let template = output ? templates.find((t) => t.code === output.code) : undefined;
      if (template === undefined) {
        template = yield* discord.createGuildTemplate({
          guild_id: news.guildId,
          name,
          description: news.description,
        });
      } else if (
        template.name !== name ||
        (template.description ?? undefined) !== news.description
      ) {
        template = yield* discord.updateGuildTemplate({
          guild_id: news.guildId,
          code: template.code,
          name,
          description: news.description ?? null,
        });
      }
      if ((news.sync ?? true) && template.is_dirty) {
        template = yield* discord.syncGuildTemplate({
          guild_id: news.guildId,
          code: template.code,
        });
      }
      return toAttributes(template);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discord
        .deleteGuildTemplate({ guild_id: output.guildId, code: output.code })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: Effect.fn(function* () {
      const botId = yield* botUserId();
      const guilds = yield* listBotGuilds();
      const rows = yield* Effect.forEach(
        guilds,
        (guild) =>
          templatesOf(guild.id).pipe(
            Effect.map((ts) => ts.filter((t) => t.creator_id === botId).map(toAttributes)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          ),
        { concurrency: 4 },
      );
      return rows.flat();
    }),
  });
