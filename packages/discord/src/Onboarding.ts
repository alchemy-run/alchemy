import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "./Providers.ts";

/** An answer to an onboarding prompt. */
export interface OnboardingOption {
  /** Answer title, up to 50 characters. */
  title: string;
  /** Answer description, up to 100 characters. */
  description?: string;
  /** Id of a guild emoji. */
  emojiId?: string;
  /** Unicode emoji. */
  emojiName?: string;
  /** Roles given to members who pick the answer. */
  roleIds?: string[];
  /** Channels opted into for members who pick the answer. */
  channelIds?: string[];
}

/** A question new members answer during onboarding. */
export interface OnboardingPrompt {
  /** Question, up to 100 characters. */
  title: string;
  /** Answers (1-50). */
  options: OnboardingOption[];
  /** Members may pick only one answer. @default false */
  singleSelect?: boolean;
  /** Members must answer before joining. @default false */
  required?: boolean;
  /** Shown during onboarding (else only in Channels & Roles). @default true */
  inOnboarding?: boolean;
  /** `multipleChoice` or `dropdown`. @default "multipleChoice" */
  type?: "multipleChoice" | "dropdown";
}

export interface OnboardingProps {
  /** Community guild whose onboarding is managed. */
  guildId: string;
  /** Whether onboarding is on. @default true */
  enabled?: boolean;
  /** Channels every member is opted into (at least 7 with prompts combined). */
  defaultChannelIds?: string[];
  /** Questions new members answer. */
  prompts?: OnboardingPrompt[];
  /**
   * `default` counts only default channels toward the requirements;
   * `advanced` counts prompt channels too.
   * @default "default"
   */
  mode?: "default" | "advanced";
}

export interface OnboardingAttributes {
  /** Guild id. */
  guildId: string;
  /** Whether onboarding is on. */
  enabled: boolean;
  /** The onboarding before the stack managed it; destroy restores it. */
  initial: {
    enabled: boolean;
    default_channel_ids: string[];
    prompts: unknown[];
    mode: number;
  };
}

/**
 * The onboarding flow of a Community guild: default channels and the
 * questions new members answer to pick roles and channels.
 *
 * The guild needs the `COMMUNITY` feature, and the bot `MANAGE_GUILD` and
 * `MANAGE_ROLES`. Every deploy replaces the whole flow with the declared one.
 * The first deploy records the original flow and destroy restores it.
 *
 * ### Onboarding Members
 * **Example:** Ask what members are here for
 * ```typescript
 * yield* Discord.Onboarding("Onboarding", {
 *   guildId,
 *   defaultChannelIds: [general.channelId, announcements.channelId],
 *   prompts: [
 *     {
 *       title: "What brings you here?",
 *       options: [
 *         { title: "Building", roleIds: [builders.roleId], channelIds: [showcase.channelId] },
 *         { title: "Learning", channelIds: [help.channelId] },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @product Guild
 */
export interface Onboarding extends Resource<
  "Discord.Onboarding",
  OnboardingProps,
  OnboardingAttributes,
  never,
  Providers
> {}

export const Onboarding = Resource<Onboarding>("Discord.Onboarding");

const snapshot = (o: discord.UserGuildOnboardingResponse): OnboardingAttributes["initial"] => ({
  enabled: o.enabled,
  default_channel_ids: [...o.default_channel_ids],
  prompts: [...o.prompts],
  mode: "mode" in o ? Number(o.mode) : 0,
});

const promptsBody = (prompts: OnboardingPrompt[]) =>
  prompts.map((p, i) => ({
    // New prompts and options take any unique snowflake-shaped id.
    id: String(i),
    title: p.title,
    single_select: p.singleSelect ?? false,
    required: p.required ?? false,
    in_onboarding: p.inOnboarding ?? true,
    type: p.type === "dropdown" ? 1 : 0,
    options: p.options.map((o) => ({
      title: o.title,
      description: o.description,
      emoji_id: o.emojiId,
      emoji_name: o.emojiName,
      role_ids: o.roleIds ?? [],
      channel_ids: o.channelIds ?? [],
    })),
  }));

export const OnboardingProvider = () =>
  Provider.succeed(Onboarding, {
    nuke: { singleton: true },
    stables: ["guildId"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news) || olds === undefined) return;
      if (news.guildId !== olds.guildId) return { action: "replace" } as const;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const guildId = output?.guildId ?? olds?.guildId;
      if (guildId === undefined) return undefined;
      const o = yield* discord
        .getGuildsOnboarding({ guild_id: guildId })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      return o
        ? { guildId, enabled: o.enabled, initial: output?.initial ?? snapshot(o) }
        : undefined;
    }),

    // Prompts are matched by position, so the flow is replaced whole. PUT is
    // a full replace on Discord's side too.
    reconcile: Effect.fn(function* ({ news, output }) {
      const observed = yield* discord.getGuildsOnboarding({ guild_id: news.guildId });
      const initial = output?.initial ?? snapshot(observed);
      const updated = yield* discord.putGuildsOnboarding({
        guild_id: news.guildId,
        enabled: news.enabled ?? true,
        default_channel_ids: news.defaultChannelIds ?? [],
        prompts: promptsBody(news.prompts ?? []),
        mode: news.mode === "advanced" ? 1 : 0,
      });
      return { guildId: news.guildId, enabled: updated.enabled, initial };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discord
        .putGuildsOnboarding({
          guild_id: output.guildId,
          enabled: output.initial.enabled,
          default_channel_ids: output.initial.default_channel_ids,
          prompts: output.initial.prompts as discord.PutGuildsOnboardingRequest["prompts"],
          mode: output.initial.mode as discord.PutGuildsOnboardingRequest["mode"],
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: () => Effect.succeed([]),
  });
