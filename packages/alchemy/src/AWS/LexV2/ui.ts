import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Bot } from "./Bot.ts";
import type { BotAlias } from "./BotAlias.ts";
import type { BotLocale } from "./BotLocale.ts";
import type { BotVersion } from "./BotVersion.ts";
import type { Intent } from "./Intent.ts";
import type { SlotType } from "./SlotType.ts";

/**
 * Dashboard UI providers for AWS Lex V2 resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const COLOR = "#01A88D";

const regionOf = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const BotUI = UIProvider.succeed<Bot>("AWS.LexV2.Bot", {
  displayName: "Lex Bot",
  icon: "bot",
  color: COLOR,
  category: "ai",
  summary: (ctx) => ctx.attrs?.botName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.botArn);
    return ctx.attrs?.botId === undefined || region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/lexv2/home?region=${region}#bot/${ctx.attrs.botId}`;
  },
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.botName, copy: true },
    { label: "id", value: ctx.attrs?.botId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.botArn, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.botStatus },
    { label: "role", value: ctx.attrs?.roleArn, mono: true },
  ],
});

export const BotAliasUI = UIProvider.succeed<BotAlias>("AWS.LexV2.BotAlias", {
  displayName: "Lex Bot Alias",
  icon: "tag",
  color: COLOR,
  category: "ai",
  summary: (ctx) => ctx.attrs?.botAliasName,
  facts: (ctx) => [
    { label: "alias", value: ctx.attrs?.botAliasName, copy: true },
    { label: "id", value: ctx.attrs?.botAliasId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.botAliasArn, mono: true, copy: true },
    { label: "bot", value: ctx.attrs?.botId, mono: true },
    { label: "version", value: ctx.attrs?.botVersion },
    { label: "status", value: ctx.attrs?.botAliasStatus },
  ],
});

export const BotLocaleUI = UIProvider.succeed<BotLocale>(
  "AWS.LexV2.BotLocale",
  {
    displayName: "Lex Bot Locale",
    icon: "languages",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.localeName ?? ctx.attrs?.localeId,
    facts: (ctx) => [
      { label: "locale", value: ctx.attrs?.localeId, copy: true },
      { label: "name", value: ctx.attrs?.localeName },
      { label: "bot", value: ctx.attrs?.botId, mono: true },
      { label: "status", value: ctx.attrs?.botLocaleStatus },
    ],
  },
);

export const BotVersionUI = UIProvider.succeed<BotVersion>(
  "AWS.LexV2.BotVersion",
  {
    displayName: "Lex Bot Version",
    icon: "git-branch",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.botVersion,
    facts: (ctx) => [
      { label: "version", value: ctx.attrs?.botVersion, copy: true },
      { label: "bot", value: ctx.attrs?.botId, mono: true },
      { label: "status", value: ctx.attrs?.botStatus },
      {
        label: "locales",
        value: ctx.attrs?.localeIds?.length
          ? ctx.attrs.localeIds.join(", ")
          : undefined,
      },
    ],
  },
);

export const IntentUI = UIProvider.succeed<Intent>("AWS.LexV2.Intent", {
  displayName: "Lex Intent",
  icon: "message-square",
  color: COLOR,
  category: "ai",
  summary: (ctx) => ctx.attrs?.intentName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.intentName, copy: true },
    { label: "id", value: ctx.attrs?.intentId, mono: true, copy: true },
    { label: "bot", value: ctx.attrs?.botId, mono: true },
    { label: "locale", value: ctx.attrs?.localeId },
  ],
});

export const SlotTypeUI = UIProvider.succeed<SlotType>("AWS.LexV2.SlotType", {
  displayName: "Lex Slot Type",
  icon: "list-ordered",
  color: COLOR,
  category: "ai",
  summary: (ctx) => ctx.attrs?.slotTypeName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.slotTypeName, copy: true },
    { label: "id", value: ctx.attrs?.slotTypeId, mono: true, copy: true },
    { label: "bot", value: ctx.attrs?.botId, mono: true },
    { label: "locale", value: ctx.attrs?.localeId },
  ],
});

export const ui = () =>
  Layer.mergeAll(
    BotUI,
    BotAliasUI,
    BotLocaleUI,
    BotVersionUI,
    IntentUI,
    SlotTypeUI,
  );
