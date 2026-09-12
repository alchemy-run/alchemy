import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { DdosAllowlistEntry } from "./AllowlistEntry.ts";
import type { SynProtectionFilter } from "./SynProtectionFilter.ts";
import type { SynProtectionRule } from "./SynProtectionRule.ts";
import type { TcpFlowProtectionFilter } from "./TcpFlowProtectionFilter.ts";
import type { TcpFlowProtectionRule } from "./TcpFlowProtectionRule.ts";

/**
 * Dashboard UI providers for Cloudflare DDoS Protection resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const DdosAllowlistEntryUI = UIProvider.succeed<DdosAllowlistEntry>(
  "Cloudflare.DdosProtection.AllowlistEntry",
  {
    displayName: "DDoS Allowlist Entry",
    icon: "shield-check",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.prefix ?? ctx.props?.prefix,
    facts: (ctx) => [
      { label: "prefix", value: ctx.attrs?.prefix, mono: true, copy: true },
      { label: "id", value: ctx.attrs?.allowlistId, mono: true, copy: true },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "comment", value: ctx.attrs?.comment },
      { label: "modified", value: ctx.attrs?.modifiedOn },
    ],
  },
);

export const SynProtectionRuleUI = UIProvider.succeed<SynProtectionRule>(
  "Cloudflare.DdosProtection.SynProtectionRule",
  {
    displayName: "SYN Protection Rule",
    icon: "shield",
    color: "#F6821F",
    category: "security",
    summary: (ctx) =>
      ctx.attrs?.name === undefined
        ? ctx.props?.name
        : `${ctx.attrs.name} (${ctx.attrs.mode})`,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name },
      { label: "scope", value: ctx.attrs?.scope },
      { label: "mode", value: ctx.attrs?.mode },
      { label: "burst sensitivity", value: ctx.attrs?.burstSensitivity },
      { label: "rate sensitivity", value: ctx.attrs?.rateSensitivity },
      { label: "mitigation", value: ctx.attrs?.mitigationType },
      { label: "id", value: ctx.attrs?.ruleId, mono: true, copy: true },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
    ],
  },
);

export const SynProtectionFilterUI = UIProvider.succeed<SynProtectionFilter>(
  "Cloudflare.DdosProtection.SynProtectionFilter",
  {
    displayName: "SYN Protection Filter",
    icon: "filter",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.expression ?? ctx.props?.expression,
    facts: (ctx) => [
      { label: "expression", value: ctx.attrs?.expression, mono: true },
      { label: "mode", value: ctx.attrs?.mode },
      { label: "id", value: ctx.attrs?.filterId, mono: true, copy: true },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
      { label: "modified", value: ctx.attrs?.modifiedOn },
    ],
  },
);

export const TcpFlowProtectionRuleUI =
  UIProvider.succeed<TcpFlowProtectionRule>(
    "Cloudflare.DdosProtection.TcpFlowProtectionRule",
    {
      displayName: "TCP Flow Protection Rule",
      icon: "shield",
      color: "#F6821F",
      category: "security",
      summary: (ctx) =>
        ctx.attrs?.name === undefined
          ? ctx.props?.name
          : `${ctx.attrs.name} (${ctx.attrs.mode})`,
      facts: (ctx) => [
        { label: "name", value: ctx.attrs?.name },
        { label: "scope", value: ctx.attrs?.scope },
        { label: "mode", value: ctx.attrs?.mode },
        { label: "burst sensitivity", value: ctx.attrs?.burstSensitivity },
        { label: "rate sensitivity", value: ctx.attrs?.rateSensitivity },
        { label: "id", value: ctx.attrs?.ruleId, mono: true, copy: true },
        {
          label: "account",
          value: ctx.attrs?.accountId,
          mono: true,
          copy: true,
        },
      ],
    },
  );

export const TcpFlowProtectionFilterUI =
  UIProvider.succeed<TcpFlowProtectionFilter>(
    "Cloudflare.DdosProtection.TcpFlowProtectionFilter",
    {
      displayName: "TCP Flow Protection Filter",
      icon: "filter",
      color: "#F6821F",
      category: "security",
      summary: (ctx) => ctx.attrs?.expression ?? ctx.props?.expression,
      facts: (ctx) => [
        { label: "expression", value: ctx.attrs?.expression, mono: true },
        { label: "mode", value: ctx.attrs?.mode },
        { label: "id", value: ctx.attrs?.filterId, mono: true, copy: true },
        {
          label: "account",
          value: ctx.attrs?.accountId,
          mono: true,
          copy: true,
        },
        { label: "modified", value: ctx.attrs?.modifiedOn },
      ],
    },
  );

export const ui = () =>
  Layer.mergeAll(
    DdosAllowlistEntryUI,
    SynProtectionRuleUI,
    SynProtectionFilterUI,
    TcpFlowProtectionRuleUI,
    TcpFlowProtectionFilterUI,
  );
