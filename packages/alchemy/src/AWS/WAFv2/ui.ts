import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { IPSet } from "./IPSet.ts";
import type { LoggingConfiguration } from "./LoggingConfiguration.ts";
import type { RegexPatternSet } from "./RegexPatternSet.ts";
import type { RuleGroup } from "./RuleGroup.ts";
import type { WebACL } from "./WebACL.ts";
import type { WebACLAssociation } from "./WebACLAssociation.ts";

/**
 * Dashboard UI providers for AWS WAFv2 resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** WAFv2 brand color (AWS Security, Identity & Compliance red). */
const WAFV2_COLOR = "#DD344C";

export const WebACLUI = UIProvider.succeed<WebACL>("AWS.WAFv2.WebACL", {
  displayName: "WAF Web ACL",
  icon: "shield",
  color: WAFV2_COLOR,
  category: "security",
  summary: (ctx) => ctx.attrs?.webAclName,
  facts: (ctx) => [
    { label: "web acl", value: ctx.attrs?.webAclName, copy: true },
    { label: "id", value: ctx.attrs?.webAclId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.webAclArn, mono: true, copy: true },
    { label: "scope", value: ctx.attrs?.scope },
  ],
});

export const IPSetUI = UIProvider.succeed<IPSet>("AWS.WAFv2.IPSet", {
  displayName: "WAF IP Set",
  icon: "network",
  color: WAFV2_COLOR,
  category: "security",
  summary: (ctx) => ctx.attrs?.ipSetName,
  facts: (ctx) => [
    { label: "ip set", value: ctx.attrs?.ipSetName, copy: true },
    { label: "id", value: ctx.attrs?.ipSetId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.ipSetArn, mono: true, copy: true },
    { label: "scope", value: ctx.attrs?.scope },
    { label: "ip version", value: ctx.attrs?.ipAddressVersion },
    { label: "addresses", value: ctx.attrs?.addresses?.length },
  ],
});

export const RegexPatternSetUI = UIProvider.succeed<RegexPatternSet>(
  "AWS.WAFv2.RegexPatternSet",
  {
    displayName: "WAF Regex Pattern Set",
    icon: "code",
    color: WAFV2_COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.regexPatternSetName,
    facts: (ctx) => [
      {
        label: "pattern set",
        value: ctx.attrs?.regexPatternSetName,
        copy: true,
      },
      {
        label: "id",
        value: ctx.attrs?.regexPatternSetId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.regexPatternSetArn,
        mono: true,
        copy: true,
      },
      { label: "scope", value: ctx.attrs?.scope },
      { label: "expressions", value: ctx.attrs?.regularExpressions?.length },
    ],
  },
);

export const RuleGroupUI = UIProvider.succeed<RuleGroup>(
  "AWS.WAFv2.RuleGroup",
  {
    displayName: "WAF Rule Group",
    icon: "list-ordered",
    color: WAFV2_COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.ruleGroupName,
    facts: (ctx) => [
      { label: "rule group", value: ctx.attrs?.ruleGroupName, copy: true },
      { label: "id", value: ctx.attrs?.ruleGroupId, mono: true, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.ruleGroupArn,
        mono: true,
        copy: true,
      },
      { label: "scope", value: ctx.attrs?.scope },
      { label: "capacity", value: ctx.attrs?.capacity },
    ],
  },
);

export const LoggingConfigurationUI = UIProvider.succeed<LoggingConfiguration>(
  "AWS.WAFv2.LoggingConfiguration",
  {
    displayName: "WAF Logging Configuration",
    icon: "scroll-text",
    color: WAFV2_COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.resourceArn,
    facts: (ctx) => [
      {
        label: "resource",
        value: ctx.attrs?.resourceArn,
        mono: true,
        copy: true,
      },
      { label: "scope", value: ctx.attrs?.scope },
      {
        label: "destinations",
        value: ctx.attrs?.logDestinationConfigs?.join(", "),
        mono: true,
      },
    ],
  },
);

export const WebACLAssociationUI = UIProvider.succeed<WebACLAssociation>(
  "AWS.WAFv2.WebACLAssociation",
  {
    displayName: "WAF Web ACL Association",
    icon: "link",
    color: WAFV2_COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.resourceArn,
    facts: (ctx) => [
      { label: "web acl", value: ctx.attrs?.webAclArn, mono: true, copy: true },
      {
        label: "resource",
        value: ctx.attrs?.resourceArn,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    WebACLUI,
    IPSetUI,
    RegexPatternSetUI,
    RuleGroupUI,
    LoggingConfigurationUI,
    WebACLAssociationUI,
  );
