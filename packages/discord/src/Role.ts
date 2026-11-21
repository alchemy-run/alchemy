import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  AuditLogAction,
  colorToInt,
  isCreatedByBot,
  ownedPerGuild,
  ownership,
  physicalName,
} from "./internal/Discord.ts";
import type { Providers } from "./Providers.ts";

export interface RoleProps {
  /** Guild the role belongs to. Changing it replaces the role. */
  guildId: string;
  /**
   * Role name, up to 100 characters.
   * @default a name generated from the app, stage and logical id
   */
  name?: string;
  /**
   * Permission bit set, as a decimal string (see {@link Permissions} and
   * `combinePermissions`) or a number.
   * @default "0"
   */
  permissions?: string | number;
  /**
   * Role color as `#RRGGBB`, `RRGGBB` or an integer. `0` means no color.
   * @default 0
   */
  color?: string | number;
  /** Show members with the role separately in the member list. @default false */
  hoist?: boolean;
  /** Anyone can @mention the role. @default false */
  mentionable?: boolean;
  /** Unicode emoji shown as the role icon (needs the `ROLE_ICONS` guild feature). */
  unicodeEmoji?: string;
  /**
   * Position in the role list (higher is above). The bot can only place a
   * role below its own highest role.
   */
  position?: number;
}

export interface RoleAttributes {
  /** Role id (a snowflake). */
  roleId: string;
  /** Guild the role belongs to. */
  guildId: string;
  /** Role name. */
  name: string;
  /** Permission bit set, as a decimal string. */
  permissions: string;
  /** Role color as an integer. */
  color: number;
  /** Whether members are shown separately. */
  hoist: boolean;
  /** Whether the role is mentionable. */
  mentionable: boolean;
  /** Position in the role list. */
  position: number;
  /** `<@&roleId>`, the mention syntax for the role. */
  mention: string;
}

/**
 * A role in a Discord guild.
 *
 * The bot needs `MANAGE_ROLES`, and can only create or edit roles below its
 * own highest role. A role belongs to the stack when the bot created it
 * (per the audit log); a same-named role someone else created is reported as
 * foreign and needs `--adopt`.
 *
 * ### Creating Roles
 * **Example:** Moderator role
 * ```typescript
 * const moderator = yield* Discord.Role("Moderator", {
 *   guildId,
 *   name: "Moderator",
 *   color: "#5865F2",
 *   hoist: true,
 *   permissions: Discord.combinePermissions(
 *     Discord.Permissions.KickMembers,
 *     Discord.Permissions.ManageMessages,
 *     Discord.Permissions.ModerateMembers,
 *   ),
 * });
 * ```
 *
 * ### Using a Role
 * **Example:** Give the role access to a private channel
 * ```typescript
 * yield* Discord.Channel("Staff", {
 *   guildId,
 *   name: "staff",
 *   permissionOverwrites: [
 *     { id: guildId, type: "role", deny: Discord.Permissions.ViewChannel },
 *     { id: moderator.roleId, type: "role", allow: Discord.Permissions.ViewChannel },
 *   ],
 * });
 * ```
 *
 * **Example:** Assign the role to a member
 * ```typescript
 * yield* Discord.MemberRole("SamIsModerator", {
 *   guildId,
 *   userId: "123456789012345678",
 *   roleId: moderator.roleId,
 * });
 * ```
 *
 * @resource
 * @product Role
 */
export interface Role extends Resource<
  "Discord.Role",
  RoleProps,
  RoleAttributes,
  never,
  Providers
> {}

export const Role = Resource<Role>("Discord.Role");

const toAttributes = (guildId: string, role: discord.GuildRoleResponse): RoleAttributes => ({
  roleId: role.id,
  guildId,
  name: role.name,
  permissions: role.permissions,
  color: role.color,
  hoist: role.hoist,
  mentionable: role.mentionable,
  position: role.position,
  mention: `<@&${role.id}>`,
});

const getRole = (guildId: string, roleId: string) =>
  discord
    .getGuildRole({ guild_id: guildId, role_id: roleId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const nameFor = (id: string, instanceId: string, props: { name?: string }) =>
  props.name !== undefined
    ? Effect.succeed(props.name)
    : physicalName(id, { instanceId, maxLength: 100 });

export const RoleProvider = () =>
  Provider.succeed(Role, {
    stables: ["roleId", "guildId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return;
      const guildId = output?.guildId ?? olds?.guildId;
      if (guildId !== undefined && news.guildId !== guildId) return { action: "replace" } as const;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      if (output !== undefined) {
        const role = yield* getRole(output.guildId, output.roleId);
        return role ? toAttributes(output.guildId, role) : undefined;
      }
      if (olds?.guildId === undefined) return undefined;
      const name = yield* nameFor(id, instanceId, olds);
      const roles = (yield* discord.listGuildRoles({ guild_id: olds.guildId })) ?? [];
      const match = roles.find((r) => r.name === name && !r.managed);
      if (match === undefined) return undefined;
      const owned = yield* isCreatedByBot(olds.guildId, AuditLogAction.RoleCreate, match.id);
      return ownership(toAttributes(olds.guildId, match), owned);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const name =
        news.name === undefined && output?.name !== undefined
          ? output.name
          : yield* nameFor(id, instanceId, news);
      const desired = {
        name,
        permissions: news.permissions === undefined ? undefined : Number(news.permissions),
        color: colorToInt(news.color) ?? 0,
        hoist: news.hoist ?? false,
        mentionable: news.mentionable ?? false,
        unicode_emoji: news.unicodeEmoji,
      };

      // Observe
      let role = output ? yield* getRole(news.guildId, output.roleId) : undefined;

      // Ensure
      if (role === undefined) {
        role = yield* discord.createGuildRole({ guild_id: news.guildId, ...desired });
      } else {
        // Sync — only the fields that drifted.
        const body: Omit<discord.UpdateGuildRoleRequest, "guild_id" | "role_id"> = {};
        if (role.name !== desired.name) body.name = desired.name;
        if (desired.permissions !== undefined && role.permissions !== String(news.permissions)) {
          body.permissions = desired.permissions;
        }
        if (role.color !== desired.color) body.color = desired.color;
        if (role.hoist !== desired.hoist) body.hoist = desired.hoist;
        if (role.mentionable !== desired.mentionable) body.mentionable = desired.mentionable;
        if (
          desired.unicode_emoji !== undefined &&
          (role.unicode_emoji ?? undefined) !== desired.unicode_emoji
        ) {
          body.unicode_emoji = desired.unicode_emoji;
        }
        if (Object.keys(body).length > 0) {
          role = yield* discord.updateGuildRole({
            guild_id: news.guildId,
            role_id: role.id,
            ...body,
          });
        }
      }

      // Position is a separate bulk call.
      if (news.position !== undefined && role.position !== news.position) {
        const roles = yield* discord.bulkUpdateGuildRoles({
          guild_id: news.guildId,
          body: [{ id: role.id, position: news.position }],
        });
        role = (roles ?? []).find((r) => r.id === role!.id) ?? role;
      }
      return toAttributes(news.guildId, role);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discord
        .deleteGuildRole({ guild_id: output.guildId, role_id: output.roleId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: Effect.fn(function* () {
      const owned = yield* ownedPerGuild(AuditLogAction.RoleCreate);
      const rows = yield* Effect.forEach(
        owned.filter(({ ids }) => ids.size > 0),
        ({ guildId, ids }) =>
          discord
            .listGuildRoles({ guild_id: guildId })
            .pipe(
              Effect.map((roles) =>
                (roles ?? []).filter((r) => ids.has(r.id)).map((r) => toAttributes(guildId, r)),
              ),
            ),
        { concurrency: 4 },
      );
      return rows.flat();
    }),
  });
