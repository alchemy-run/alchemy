import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AccountEntrypoint } from "./AccountEntrypoint.ts";
import type { CustomRuleset } from "./CustomRuleset.ts";
import type { Ruleset } from "./Ruleset.ts";

/**
 * Dashboard UI providers for Cloudflare Ruleset resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const RulesetUI = UIProvider.succeed<Ruleset>(
  "Cloudflare.Ruleset.Ruleset",
  {
    displayName: "Ruleset",
    icon: "shield",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.phase ?? ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name },
      { label: "phase", value: ctx.attrs?.phase, mono: true },
      {
        label: "ruleset id",
        value: ctx.attrs?.rulesetId,
        mono: true,
        copy: true,
      },
      { label: "zone id", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "kind", value: ctx.attrs?.kind },
      { label: "rules", value: ctx.attrs?.rules?.length },
      { label: "version", value: ctx.attrs?.version, mono: true },
    ],
  },
);

export const CustomRulesetUI = UIProvider.succeed<CustomRuleset>(
  "Cloudflare.Rulesets.CustomRuleset",
  {
    displayName: "Custom Ruleset",
    icon: "shield-plus",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name },
      { label: "phase", value: ctx.attrs?.phase, mono: true },
      {
        label: "ruleset id",
        value: ctx.attrs?.rulesetId,
        mono: true,
        copy: true,
      },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
      { label: "kind", value: ctx.attrs?.kind },
      { label: "rules", value: ctx.attrs?.rules?.length },
      { label: "version", value: ctx.attrs?.version, mono: true },
    ],
  },
);

export const AccountEntrypointUI = UIProvider.succeed<AccountEntrypoint>(
  "Cloudflare.Rulesets.AccountEntrypoint",
  {
    displayName: "Account Ruleset Entrypoint",
    icon: "shield-check",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.phase ?? ctx.props?.phase,
    facts: (ctx) => [
      { label: "phase", value: ctx.attrs?.phase, mono: true },
      {
        label: "ruleset id",
        value: ctx.attrs?.rulesetId,
        mono: true,
        copy: true,
      },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name },
      { label: "rules", value: ctx.attrs?.rules?.length },
      { label: "version", value: ctx.attrs?.version, mono: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(RulesetUI, CustomRulesetUI, AccountEntrypointUI);
