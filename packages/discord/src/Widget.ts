import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "./Providers.ts";

export interface WidgetProps {
  /** Guild whose widget is managed. */
  guildId: string;
  /** Whether the widget is on. @default true */
  enabled?: boolean;
  /** Channel the widget's instant invite opens. */
  channelId?: string;
}

export interface WidgetAttributes {
  /** Guild id. */
  guildId: string;
  /** Whether the widget is on. */
  enabled: boolean;
  /** Invite channel. */
  channelId: string | undefined;
  /** `https://discord.com/api/guilds/{id}/widget.json`, the public widget data. */
  jsonUrl: string;
  /** `https://discord.com/widget?id={id}`, the embeddable widget page. */
  embedUrl: string;
  /** The settings before the stack managed them; destroy restores them. */
  initial: { enabled: boolean; channelId: string | null };
}

/**
 * A guild's server widget: the public JSON and embeddable iframe that show
 * who's online and offer an invite.
 *
 * The bot needs `MANAGE_GUILD`. The first deploy records the original
 * settings and destroy restores them.
 *
 * ### Enabling the Widget
 * **Example:** Widget that invites to #welcome
 * ```typescript
 * const widget = yield* Discord.Widget("Widget", {
 *   guildId,
 *   channelId: welcome.channelId,
 * });
 * // <iframe src={widget.embedUrl} width="350" height="500" />
 * ```
 *
 * @resource
 * @product Guild
 */
export interface Widget extends Resource<
  "Discord.Widget",
  WidgetProps,
  WidgetAttributes,
  never,
  Providers
> {}

export const Widget = Resource<Widget>("Discord.Widget");

const toAttributes = (
  guildId: string,
  s: discord.WidgetSettingsResponse,
  initial: WidgetAttributes["initial"],
): WidgetAttributes => ({
  guildId,
  enabled: s.enabled,
  channelId: s.channel_id ?? undefined,
  jsonUrl: `https://discord.com/api/guilds/${guildId}/widget.json`,
  embedUrl: `https://discord.com/widget?id=${guildId}`,
  initial,
});

const getSettings = (guildId: string) =>
  discord
    .getGuildWidgetSettings({ guild_id: guildId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const WidgetProvider = () =>
  Provider.succeed(Widget, {
    nuke: { singleton: true },
    stables: ["guildId", "jsonUrl", "embedUrl"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news) || olds === undefined) return;
      if (news.guildId !== olds.guildId) return { action: "replace" } as const;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const guildId = output?.guildId ?? olds?.guildId;
      if (guildId === undefined) return undefined;
      const s = yield* getSettings(guildId);
      return s
        ? toAttributes(
            guildId,
            s,
            output?.initial ?? { enabled: s.enabled, channelId: s.channel_id },
          )
        : undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const observed = yield* discord.getGuildWidgetSettings({ guild_id: news.guildId });
      const initial = output?.initial ?? {
        enabled: observed.enabled,
        channelId: observed.channel_id,
      };
      const enabled = news.enabled ?? true;
      const channelId = news.channelId ?? observed.channel_id;
      if (observed.enabled === enabled && observed.channel_id === channelId) {
        return toAttributes(news.guildId, observed, initial);
      }
      const updated = yield* discord.updateGuildWidgetSettings({
        guild_id: news.guildId,
        enabled,
        channel_id: channelId,
      });
      return toAttributes(news.guildId, updated, initial);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discord
        .updateGuildWidgetSettings({
          guild_id: output.guildId,
          enabled: output.initial.enabled,
          channel_id: output.initial.channelId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: () => Effect.succeed([]),
  });
