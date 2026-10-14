import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Firewall } from "./Firewall.ts";
import type { FirewallPolicy } from "./FirewallPolicy.ts";
import type { LoggingConfiguration } from "./LoggingConfiguration.ts";
import type { RuleGroup } from "./RuleGroup.ts";

/**
 * Dashboard UI providers for AWS NetworkFirewall resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const FirewallUI = UIProvider.succeed<Firewall>(
  "AWS.NetworkFirewall.Firewall",
  {
    displayName: "Network Firewall",
    icon: "shield-check",
    color: "#8C4FFF",
    category: "network",
    summary: (ctx) => ctx.attrs?.firewallName,
    facts: (ctx) => [
      { label: "firewall", value: ctx.attrs?.firewallName, copy: true },
      { label: "arn", value: ctx.attrs?.firewallArn, mono: true, copy: true },
      { label: "id", value: ctx.attrs?.firewallId, mono: true },
      { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
      { label: "endpoints", value: ctx.attrs?.endpointIds?.length },
    ],
  },
);

export const FirewallPolicyUI = UIProvider.succeed<FirewallPolicy>(
  "AWS.NetworkFirewall.FirewallPolicy",
  {
    displayName: "Network Firewall Policy",
    icon: "scroll-text",
    color: "#8C4FFF",
    category: "network",
    summary: (ctx) => ctx.attrs?.firewallPolicyName,
    facts: (ctx) => [
      { label: "policy", value: ctx.attrs?.firewallPolicyName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.firewallPolicyArn,
        mono: true,
        copy: true,
      },
      { label: "id", value: ctx.attrs?.firewallPolicyId, mono: true },
    ],
  },
);

export const LoggingConfigurationUI = UIProvider.succeed<LoggingConfiguration>(
  "AWS.NetworkFirewall.LoggingConfiguration",
  {
    displayName: "Network Firewall Logging",
    icon: "file-text",
    color: "#8C4FFF",
    category: "observability",
    summary: (ctx) => ctx.attrs?.firewallArn?.split("/").pop(),
    facts: (ctx) => [
      {
        label: "firewall",
        value: ctx.attrs?.firewallArn,
        mono: true,
        copy: true,
      },
      {
        label: "destinations",
        value: ctx.props?.logDestinationConfigs?.length,
      },
    ],
  },
);

export const RuleGroupUI = UIProvider.succeed<RuleGroup>(
  "AWS.NetworkFirewall.RuleGroup",
  {
    displayName: "Network Firewall Rule Group",
    icon: "list-ordered",
    color: "#8C4FFF",
    category: "network",
    summary: (ctx) => ctx.attrs?.ruleGroupName,
    facts: (ctx) => [
      { label: "rule group", value: ctx.attrs?.ruleGroupName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.ruleGroupArn,
        mono: true,
        copy: true,
      },
      { label: "id", value: ctx.attrs?.ruleGroupId, mono: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "capacity", value: ctx.attrs?.capacity },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    FirewallUI,
    FirewallPolicyUI,
    LoggingConfigurationUI,
    RuleGroupUI,
  );
