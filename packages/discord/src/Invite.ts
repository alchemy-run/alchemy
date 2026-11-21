import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { botUserId, listBotGuilds, sameJson } from "./internal/Discord.ts";
import type { Providers } from "./Providers.ts";

export interface InviteProps {
  /** Channel the invite opens. */
  channelId: string;
  /**
   * Seconds until the invite expires, up to 604800 (7 days). `0` never
   * expires.
   * @default 0
   */
  maxAge?: number;
  /** Times the invite can be used (0-100). `0` is unlimited. @default 0 */
  maxUses?: number;
  /** Members who join through it are kicked when they go offline without a role. @default false */
  temporary?: boolean;
  /** Roles given to members who join through the invite. */
  roleIds?: string[];
}

export interface InviteAttributes {
  /** Invite code. */
  code: string;
  /** Channel the invite opens. */
  channelId: string;
  /** Guild of the channel. */
  guildId: string | undefined;
  /** `https://discord.gg/{code}`. */
  url: string;
  /** When it expires, ISO 8601; `undefined` never expires. */
  expiresAt: string | undefined;
}

/**
 * A guild invite link.
 *
 * The bot needs `CREATE_INSTANT_INVITE` in the channel. Invites can't be
 * edited, so changing any prop revokes the invite and creates a new code. An
 * invite belongs to the stack when the bot created it.
 *
 * ### Creating Invites
 * **Example:** Permanent invite to the welcome channel
 * ```typescript
 * const welcome = yield* Discord.Channel("Welcome", { guildId, name: "welcome" });
 * const invite = yield* Discord.Invite("Public", { channelId: welcome.channelId });
 * // invite.url === "https://discord.gg/abc123"
 * ```
 *
 * **Example:** One-day invite for 10 people
 * ```typescript
 * yield* Discord.Invite("Event", {
 *   channelId: welcome.channelId,
 *   maxAge: 86400,
 *   maxUses: 10,
 * });
 * ```
 *
 * @resource
 * @product Invite
 */
export interface Invite extends Resource<
  "Discord.Invite",
  InviteProps,
  InviteAttributes,
  never,
  Providers
> {}

export const Invite = Resource<Invite>("Discord.Invite");

const toAttributes = (invite: {
  code: string;
  channel?: { id: string } | null;
  guild?: { id: string } | null;
  expires_at?: string | null;
}): InviteAttributes => ({
  code: invite.code,
  channelId: invite.channel?.id ?? "",
  guildId: invite.guild?.id ?? undefined,
  url: `https://discord.gg/${invite.code}`,
  expiresAt: invite.expires_at ?? undefined,
});

const settings = (props: InviteProps) => ({
  channelId: props.channelId,
  maxAge: props.maxAge ?? 0,
  maxUses: props.maxUses ?? 0,
  temporary: props.temporary ?? false,
  roleIds: [...(props.roleIds ?? [])].sort(),
});

export const InviteProvider = () =>
  Provider.succeed(Invite, {
    stables: ["code", "url"],

    // Invites are immutable: any change is a new code.
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news) || olds === undefined) return;
      if (!sameJson(settings(news), settings(olds))) return { action: "replace" } as const;
    }),

    read: Effect.fn(function* ({ output }) {
      // A cold read can't find an invite: codes are random.
      if (output === undefined) return undefined;
      const invite = yield* discord
        .inviteResolve({ code: output.code })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      return invite ? { ...toAttributes(invite), channelId: output.channelId } : undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Observe — the invite still resolves.
      if (output !== undefined) {
        const invite = yield* discord
          .inviteResolve({ code: output.code })
          .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
        if (invite !== undefined) return output;
      }
      // Ensure — `unique` always mints a new code instead of reusing one.
      const s = settings(news);
      const created = yield* discord.createChannelInvite({
        channel_id: news.channelId,
        body: {
          max_age: s.maxAge,
          max_uses: s.maxUses,
          temporary: s.temporary,
          unique: true,
          role_ids: s.roleIds.length > 0 ? s.roleIds : undefined,
        },
      });
      return { ...toAttributes(created), channelId: news.channelId };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discord
        .revokeInvite({ code: output.code })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: Effect.fn(function* () {
      const botId = yield* botUserId();
      const guilds = yield* listBotGuilds();
      const rows = yield* Effect.forEach(
        guilds,
        (guild) =>
          discord.listGuildInvites({ guild_id: guild.id }).pipe(
            Effect.map((invites) =>
              (invites ?? [])
                .filter((i): i is NonNullable<typeof i> => i !== null)
                .filter((i) => "inviter" in i && i.inviter?.id === botId)
                .map(toAttributes),
            ),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          ),
        { concurrency: 4 },
      );
      return rows.flat();
    }),
  });
