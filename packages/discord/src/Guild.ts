import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { listBotGuilds } from "./internal/Discord.ts";
import type { Providers } from "./Providers.ts";

export interface GuildProps {
  /** Guild id. Give this or `name`. */
  guildId?: string;
  /** Exact guild name, among the guilds the bot is in. Give this or `guildId`. */
  name?: string;
}

export interface GuildAttributes {
  /** Guild id (a snowflake). */
  guildId: string;
  /** Guild name. */
  name: string;
  /** Owner's user id. */
  ownerId: string;
  /** Guild features, e.g. `COMMUNITY`. */
  features: string[];
  /** Id of the `@everyone` role (the same as the guild id). */
  everyoneRoleId: string;
}

/** The bot isn't in a guild with this id or name. */
export class GuildNotFound extends Data.TaggedError("Discord.GuildNotFound")<{
  readonly message: string;
}> {}

/**
 * A guild (server) the bot is in.
 *
 * Bots can't create guilds, so `Guild` references one: deploying it checks
 * the bot is a member and resolves the id, destroying it does nothing. Pass
 * it to guild bindings (`Discord.GetMember(guild)`) and take `guildId` from it
 * for guild resources. Add the bot with the application's install link
 * (`Discord.Application`'s `installUrl`).
 *
 * ### Referencing a Guild
 * **Example:** By name
 * ```typescript
 * const guild = yield* Discord.Guild("Community", { name: "Alchemy" });
 * yield* Discord.Channel("General", { guildId: guild.guildId, name: "general" });
 * ```
 *
 * **Example:** By id, for bindings
 * ```typescript
 * const guild = yield* Discord.Guild("Community", { guildId: "123456789012345678" });
 * // in a Worker's construction phase
 * const getMember = yield* Discord.GetMember(guild);
 * ```
 *
 * @resource
 * @product Guild
 */
export interface Guild extends Resource<
  "Discord.Guild",
  GuildProps,
  GuildAttributes,
  never,
  Providers,
  GuildProps
> {}

export const Guild = Resource<Guild>("Discord.Guild");

const toAttributes = (g: discord.GuildWithCountsResponse): GuildAttributes => ({
  guildId: g.id,
  name: g.name,
  ownerId: g.owner_id,
  features: [...g.features],
  everyoneRoleId: g.id,
});

const find = Effect.fn("Discord.Guild.find")(function* (props: GuildProps) {
  let guildId = props.guildId;
  if (guildId === undefined && props.name !== undefined) {
    guildId = (yield* listBotGuilds()).find((g) => g.name === props.name)?.id;
  }
  if (guildId === undefined) return undefined;
  return yield* discord.getGuild({ guild_id: guildId }).pipe(
    Effect.map(toAttributes),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );
});

export const GuildProvider = () =>
  Provider.succeed(Guild, {
    nuke: { skip: true },
    stables: ["guildId", "everyoneRoleId"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news) || olds === undefined) return;
      if (news.guildId !== olds.guildId || news.name !== olds.name) {
        return { action: "replace" } as const;
      }
    }),

    lookup: Effect.fn(function* (props) {
      return yield* find(props);
    }),

    read: Effect.fn(function* ({ olds, output }) {
      return yield* find(output ? { guildId: output.guildId } : (olds ?? {}));
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const guild = yield* find(news);
      if (guild === undefined) {
        return yield* new GuildNotFound({
          message: `The bot is not in a guild with ${news.guildId ? `id ${news.guildId}` : `name '${news.name}'`}. Invite it with the application's install link.`,
        });
      }
      return guild;
    }),

    // A reference: destroying it leaves the guild alone.
    delete: () => Effect.void,

    list: () => Effect.succeed([]),
  });
