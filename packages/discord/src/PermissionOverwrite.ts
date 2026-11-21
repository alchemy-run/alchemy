import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "./Providers.ts";

export interface PermissionOverwriteProps {
  /** Channel the overwrite applies to. */
  channelId: string;
  /** Role id (the guild id for `@everyone`) or user id. */
  targetId: string;
  /** Whether `targetId` is a role or a member. */
  type: "role" | "member";
  /** Permission bits explicitly allowed (decimal string or number). @default "0" */
  allow?: string | number;
  /** Permission bits explicitly denied (decimal string or number). @default "0" */
  deny?: string | number;
}

export interface PermissionOverwriteAttributes {
  /** Channel id. */
  channelId: string;
  /** Role or user id. */
  targetId: string;
  /** Role or member. */
  type: "role" | "member";
  /** Allowed bits, as a decimal string. */
  allow: string;
  /** Denied bits, as a decimal string. */
  deny: string;
}

/**
 * One permission overwrite on a channel: the permissions a role or member
 * is explicitly allowed or denied there.
 *
 * Use it when the role or member is declared separately from the channel, or
 * when several stacks share a channel. Don't combine it with the channel's
 * own `permissionOverwrites` prop, which replaces the whole list. The bot
 * needs `MANAGE_ROLES`. Changing `channelId`, `targetId` or `type` replaces the
 * overwrite.
 *
 * ### Granting Access
 * **Example:** Let a role see a hidden channel
 * ```typescript
 * const staff = yield* Discord.Role("Staff", { guildId, name: "Staff" });
 * const channel = yield* Discord.Channel("StaffRoom", { guildId, name: "staff-room" });
 * yield* Discord.PermissionOverwrite("HideFromEveryone", {
 *   channelId: channel.channelId,
 *   targetId: guildId,
 *   type: "role",
 *   deny: Discord.Permissions.ViewChannel,
 * });
 * yield* Discord.PermissionOverwrite("StaffCanSee", {
 *   channelId: channel.channelId,
 *   targetId: staff.roleId,
 *   type: "role",
 *   allow: Discord.Permissions.ViewChannel,
 * });
 * ```
 *
 * @resource
 * @product Channel
 */
export interface PermissionOverwrite extends Resource<
  "Discord.PermissionOverwrite",
  PermissionOverwriteProps,
  PermissionOverwriteAttributes,
  never,
  Providers
> {}

export const PermissionOverwrite = Resource<PermissionOverwrite>("Discord.PermissionOverwrite");

const observe = (channelId: string, targetId: string) =>
  discord.getChannel({ channel_id: channelId }).pipe(
    Effect.map((channel) =>
      "permission_overwrites" in channel
        ? (channel.permission_overwrites ?? []).find((o) => o.id === targetId)
        : undefined,
    ),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const toAttributes = (
  channelId: string,
  o: { id: string; type: number | string; allow: string; deny: string },
): PermissionOverwriteAttributes => ({
  channelId,
  targetId: o.id,
  type: Number(o.type) === 0 ? "role" : "member",
  allow: o.allow,
  deny: o.deny,
});

export const PermissionOverwriteProvider = () =>
  Provider.succeed(PermissionOverwrite, {
    stables: ["channelId", "targetId", "type"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news) || olds === undefined) return;
      if (
        news.channelId !== olds.channelId ||
        news.targetId !== olds.targetId ||
        news.type !== olds.type
      ) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const channelId = output?.channelId ?? olds?.channelId;
      const targetId = output?.targetId ?? olds?.targetId;
      if (channelId === undefined || targetId === undefined) return undefined;
      const observed = yield* observe(channelId, targetId);
      return observed ? toAttributes(channelId, observed) : undefined;
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const allow = String(news.allow ?? 0);
      const deny = String(news.deny ?? 0);
      const observed = yield* observe(news.channelId, news.targetId);
      if (
        observed === undefined ||
        observed.allow !== allow ||
        observed.deny !== deny ||
        toAttributes(news.channelId, observed).type !== news.type
      ) {
        yield* discord.setChannelPermissionOverwrite({
          channel_id: news.channelId,
          overwrite_id: news.targetId,
          type: news.type === "role" ? 0 : 1,
          allow: Number(allow),
          deny: Number(deny),
        });
      }
      return { channelId: news.channelId, targetId: news.targetId, type: news.type, allow, deny };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discord
        .deleteChannelPermissionOverwrite({
          channel_id: output.channelId,
          overwrite_id: output.targetId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    // Overwrites live on their channel and go with it.
    list: () => Effect.succeed([]),
  });
