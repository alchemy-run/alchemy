import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "./Providers.ts";

export interface MemberRoleProps {
  /** Guild the member and role belong to. */
  guildId: string;
  /** User id of the guild member (the member must already be in the guild). */
  userId: string;
  /** Role to give the member. */
  roleId: string;
}

export interface MemberRoleAttributes {
  /** Guild id. */
  guildId: string;
  /** Member's user id. */
  userId: string;
  /** Role id. */
  roleId: string;
}

/**
 * Gives one guild member one role, and takes it away on destroy.
 *
 * The bot needs `MANAGE_ROLES`, and the role must be below the bot's highest
 * role. Changing any prop moves the assignment: the old one is removed and the
 * new one added.
 *
 * ### Assigning Roles
 * **Example:** Make a user a moderator
 * ```typescript
 * const moderator = yield* Discord.Role("Moderator", { guildId, name: "Moderator" });
 * yield* Discord.MemberRole("AliceModerator", {
 *   guildId,
 *   userId: "123456789012345678",
 *   roleId: moderator.roleId,
 * });
 * ```
 *
 * **Example:** Give the application's own bot a role
 * ```typescript
 * const bot = yield* Discord.Bot("Bot", { username: "alchemy-bot" });
 * yield* Discord.MemberRole("BotIsModerator", {
 *   guildId,
 *   userId: bot.userId,
 *   roleId: moderator.roleId,
 * });
 * ```
 *
 * @resource
 * @product Role
 */
export interface MemberRole extends Resource<
  "Discord.MemberRole",
  MemberRoleProps,
  MemberRoleAttributes,
  never,
  Providers
> {}

export const MemberRole = Resource<MemberRole>("Discord.MemberRole");

const hasRole = (props: MemberRoleProps) =>
  discord.getGuildMember({ guild_id: props.guildId, user_id: props.userId }).pipe(
    Effect.map((member) => member.roles.includes(props.roleId)),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

export const MemberRoleProvider = () =>
  Provider.succeed(MemberRole, {
    stables: ["guildId", "userId", "roleId"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news) || olds === undefined) return;
      if (
        news.guildId !== olds.guildId ||
        news.userId !== olds.userId ||
        news.roleId !== olds.roleId
      ) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const props = output ?? olds;
      if (props?.guildId === undefined) return undefined;
      return (yield* hasRole(props))
        ? { guildId: props.guildId, userId: props.userId, roleId: props.roleId }
        : undefined;
    }),

    reconcile: Effect.fn(function* ({ news }) {
      if (!(yield* hasRole(news))) {
        yield* discord.addGuildMemberRole({
          guild_id: news.guildId,
          user_id: news.userId,
          role_id: news.roleId,
        });
      }
      return { guildId: news.guildId, userId: news.userId, roleId: news.roleId };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discord
        .deleteGuildMemberRole({
          guild_id: output.guildId,
          user_id: output.userId,
          role_id: output.roleId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    // An assignment lives on a member; deleting the role (Discord.Role's
    // `list`) removes every assignment of it.
    list: () => Effect.succeed([]),
  });
