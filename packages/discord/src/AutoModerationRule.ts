import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { botUserId, listBotGuilds, ownership, physicalName, sameJson } from "./internal/Discord.ts";
import type { Providers } from "./Providers.ts";

/** What the rule looks for. The trigger type can't change after creation. */
export type AutoModerationTrigger =
  | {
      /** Message content matches words or regular expressions. */
      type: "keyword";
      /** Substrings to match, with `*` wildcards (up to 1000). */
      keywordFilter?: string[];
      /** Rust-flavored regular expressions (up to 10). */
      regexPatterns?: string[];
      /** Substrings that never trigger the rule. */
      allowList?: string[];
    }
  | {
      /** Discord's spam detection. One per guild. */
      type: "spam";
    }
  | {
      /** Discord's curated word lists. One per guild. */
      type: "keywordPreset";
      presets: Array<"profanity" | "sexualContent" | "slurs">;
      allowList?: string[];
    }
  | {
      /** Too many unique role and user mentions. One per guild. */
      type: "mentionSpam";
      /** Mentions per message that trigger the rule (up to 50). */
      mentionTotalLimit: number;
      /** Also detect mention raids. @default false */
      mentionRaidProtectionEnabled?: boolean;
    }
  | {
      /** Member names and profiles match words or patterns. */
      type: "memberProfile";
      keywordFilter?: string[];
      regexPatterns?: string[];
      allowList?: string[];
    };

/** What the rule does when it triggers. */
export type AutoModerationAction =
  | {
      /** Block the message. */
      type: "blockMessage";
      /** Explanation shown to the author (up to 150 characters). */
      customMessage?: string;
    }
  | {
      /** Post an alert to a channel. */
      type: "sendAlert";
      channelId: string;
    }
  | {
      /** Time the author out. Keyword and mention-spam rules only. */
      type: "timeout";
      /** Up to 2419200 (four weeks). */
      durationSeconds: number;
    }
  | {
      /** Stop the member from interacting in the guild. Member-profile rules only. */
      type: "blockMemberInteraction";
    };

export interface AutoModerationRuleProps {
  /** Guild the rule belongs to. Changing it replaces the rule. */
  guildId: string;
  /**
   * Rule name.
   * @default a name generated from the app, stage and logical id
   */
  name?: string;
  /**
   * When the rule is checked: on every message, or when a member joins or
   * updates their profile (`memberProfile` triggers).
   * @default "messageSend" ("memberUpdate" for memberProfile triggers)
   */
  eventType?: "messageSend" | "memberUpdate";
  /** What the rule looks for. Changing `trigger.type` replaces the rule. */
  trigger: AutoModerationTrigger;
  /** What happens when the rule triggers. */
  actions: AutoModerationAction[];
  /** Whether the rule is active. @default true */
  enabled?: boolean;
  /** Roles the rule ignores (up to 20). */
  exemptRoles?: string[];
  /** Channels the rule ignores (up to 50). */
  exemptChannels?: string[];
}

export interface AutoModerationRuleAttributes {
  /** Rule id (a snowflake). */
  ruleId: string;
  /** Guild id. */
  guildId: string;
  /** Rule name. */
  name: string;
  /** Whether the rule is active. */
  enabled: boolean;
  /** Trigger type. */
  triggerType: AutoModerationTrigger["type"];
}

/**
 * An AutoMod rule in a Discord guild: what to look for in messages or member
 * profiles, and what to do when it matches.
 *
 * The bot needs `MANAGE_GUILD`. A rule belongs to the stack when the bot
 * created it (Discord records the creator). A guild holds up to 6 keyword
 * rules and one each of the spam, preset and mention-spam rules.
 *
 * ### Creating Rules
 * **Example:** Block invite links and alert moderators
 * ```typescript
 * yield* Discord.AutoModerationRule("NoInvites", {
 *   guildId,
 *   name: "No invite links",
 *   trigger: { type: "keyword", regexPatterns: ["discord\\.gg/\\w+"] },
 *   actions: [
 *     { type: "blockMessage", customMessage: "Invite links aren't allowed here." },
 *     { type: "sendAlert", channelId: modLog.channelId },
 *   ],
 *   exemptRoles: [moderator.roleId],
 * });
 * ```
 *
 * **Example:** Mention spam with a timeout
 * ```typescript
 * yield* Discord.AutoModerationRule("MentionSpam", {
 *   guildId,
 *   trigger: { type: "mentionSpam", mentionTotalLimit: 10 },
 *   actions: [{ type: "blockMessage" }, { type: "timeout", durationSeconds: 600 }],
 * });
 * ```
 *
 * @resource
 * @product Moderation
 */
export interface AutoModerationRule extends Resource<
  "Discord.AutoModerationRule",
  AutoModerationRuleProps,
  AutoModerationRuleAttributes,
  never,
  Providers
> {}

export const AutoModerationRule = Resource<AutoModerationRule>("Discord.AutoModerationRule");

const TRIGGER_TYPES = { keyword: 1, spam: 3, keywordPreset: 4, mentionSpam: 5, memberProfile: 6 };
const PRESETS = { profanity: 1, sexualContent: 2, slurs: 3 };
const ACTION_TYPES = { blockMessage: 1, sendAlert: 2, timeout: 3, blockMemberInteraction: 4 };

const triggerTypeName = (type: number) =>
  (Object.entries(TRIGGER_TYPES).find(([, v]) => v === type)?.[0] ??
    "keyword") as AutoModerationTrigger["type"];

const triggerMetadata = (trigger: AutoModerationTrigger): Record<string, unknown> => {
  switch (trigger.type) {
    case "keyword":
    case "memberProfile":
      return {
        keyword_filter: trigger.keywordFilter ?? [],
        regex_patterns: trigger.regexPatterns ?? [],
        allow_list: trigger.allowList ?? [],
      };
    case "keywordPreset":
      return {
        presets: trigger.presets.map((p) => PRESETS[p]),
        allow_list: trigger.allowList ?? [],
      };
    case "mentionSpam":
      return {
        mention_total_limit: trigger.mentionTotalLimit,
        mention_raid_protection_enabled: trigger.mentionRaidProtectionEnabled ?? false,
      };
    case "spam":
      return {};
  }
};

const actionBody = (action: AutoModerationAction) => {
  switch (action.type) {
    case "blockMessage":
      return {
        type: ACTION_TYPES.blockMessage,
        metadata: action.customMessage ? { custom_message: action.customMessage } : {},
      };
    case "sendAlert":
      return { type: ACTION_TYPES.sendAlert, metadata: { channel_id: action.channelId } };
    case "timeout":
      return {
        type: ACTION_TYPES.timeout,
        metadata: { duration_seconds: action.durationSeconds },
      };
    case "blockMemberInteraction":
      return { type: ACTION_TYPES.blockMemberInteraction, metadata: {} };
  }
};

const bodyOf = (name: string, news: AutoModerationRuleProps) => ({
  name,
  event_type:
    (news.eventType ?? (news.trigger.type === "memberProfile" ? "memberUpdate" : "messageSend")) ===
    "memberUpdate"
      ? 2
      : 1,
  trigger_type: TRIGGER_TYPES[news.trigger.type],
  trigger_metadata: triggerMetadata(news.trigger),
  actions: news.actions.map(actionBody),
  enabled: news.enabled ?? true,
  exempt_roles: news.exemptRoles ?? [],
  exempt_channels: news.exemptChannels ?? [],
});

type Rule = discord.GetAutoModerationRuleResponse;

/** The parts of an observed rule that {@link bodyOf} sets, in its shape. */
const observedBody = (rule: Rule, desired: ReturnType<typeof bodyOf>) => {
  const metadata = (rule.trigger_metadata ?? {}) as Record<string, unknown>;
  return {
    name: rule.name,
    event_type: Number(rule.event_type),
    trigger_type: Number(rule.trigger_type),
    trigger_metadata: Object.fromEntries(
      Object.keys(desired.trigger_metadata).map((k) => [k, metadata[k]]),
    ),
    actions: (rule.actions ?? []).map((a) => ({
      type: Number(a.type),
      metadata: Object.fromEntries(
        Object.entries((a.metadata ?? {}) as Record<string, unknown>).filter(
          ([, v]) => v !== "" && v !== null && v !== undefined,
        ),
      ),
    })),
    enabled: rule.enabled,
    exempt_roles: [...rule.exempt_roles].sort(),
    exempt_channels: [...rule.exempt_channels].sort(),
  };
};

const toAttributes = (rule: Rule): AutoModerationRuleAttributes => ({
  ruleId: rule.id,
  guildId: rule.guild_id,
  name: rule.name,
  enabled: rule.enabled,
  triggerType: triggerTypeName(Number(rule.trigger_type)),
});

const nameFor = (id: string, instanceId: string, props: { name?: string }) =>
  props.name !== undefined
    ? Effect.succeed(props.name)
    : physicalName(id, { instanceId, maxLength: 100 });

const getRule = (guildId: string, ruleId: string) =>
  discord
    .getAutoModerationRule({ guild_id: guildId, rule_id: ruleId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const AutoModerationRuleProvider = () =>
  Provider.succeed(AutoModerationRule, {
    stables: ["ruleId", "guildId", "triggerType"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || olds === undefined) return;
      if (
        news.guildId !== (output?.guildId ?? olds.guildId) ||
        news.trigger.type !== olds.trigger.type
      ) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      if (output !== undefined) {
        const rule = yield* getRule(output.guildId, output.ruleId);
        return rule ? toAttributes(rule) : undefined;
      }
      if (olds?.guildId === undefined) return undefined;
      const name = yield* nameFor(id, instanceId, olds);
      const rules = (yield* discord.listAutoModerationRules({ guild_id: olds.guildId })) ?? [];
      const match = rules.find((r) => r !== null && r.name === name);
      if (!match) return undefined;
      return ownership(toAttributes(match), match.creator_id === (yield* botUserId()));
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const name =
        news.name === undefined && output?.name !== undefined
          ? output.name
          : yield* nameFor(id, instanceId, news);
      const body = bodyOf(name, news);
      const observed = output ? yield* getRule(news.guildId, output.ruleId) : undefined;
      if (observed === undefined) {
        const created = yield* discord.createAutoModerationRule({
          guild_id: news.guildId,
          body: body as discord.CreateAutoModerationRuleRequestBody,
        });
        return toAttributes(created);
      }
      const desired = {
        ...body,
        exempt_roles: [...body.exempt_roles].sort(),
        exempt_channels: [...body.exempt_channels].sort(),
      };
      if (sameJson(observedBody(observed, body), desired)) return toAttributes(observed);
      const { trigger_type: _immutable, ...patch } = body;
      const updated = yield* discord.updateAutoModerationRule({
        guild_id: news.guildId,
        rule_id: observed.id,
        body: patch as discord.UpdateAutoModerationRuleRequestBody,
      });
      return toAttributes(updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discord
        .deleteAutoModerationRule({ guild_id: output.guildId, rule_id: output.ruleId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: Effect.fn(function* () {
      const botId = yield* botUserId();
      const guilds = yield* listBotGuilds();
      const rows = yield* Effect.forEach(
        guilds,
        (guild) =>
          discord.listAutoModerationRules({ guild_id: guild.id }).pipe(
            Effect.map((rules) =>
              (rules ?? [])
                .filter((r): r is NonNullable<typeof r> => r !== null && r.creator_id === botId)
                .map(toAttributes),
            ),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          ),
        { concurrency: 4 },
      );
      return rows.flat();
    }),
  });
