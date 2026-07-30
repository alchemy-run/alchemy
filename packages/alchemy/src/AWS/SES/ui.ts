import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ActiveReceiptRuleSet } from "./ActiveReceiptRuleSet.ts";
import type { ConfigurationSet } from "./ConfigurationSet.ts";
import type { ConfigurationSetEventDestination } from "./ConfigurationSetEventDestination.ts";
import type { EmailIdentity } from "./EmailIdentity.ts";
import type { EmailTemplate } from "./EmailTemplate.ts";
import type { ReceiptFilter } from "./ReceiptFilter.ts";
import type { ReceiptRule } from "./ReceiptRule.ts";
import type { ReceiptRuleSet } from "./ReceiptRuleSet.ts";

/**
 * Dashboard UI providers for AWS SES resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined) => arn?.split(":")[3];

export const ActiveReceiptRuleSetUI = UIProvider.succeed<ActiveReceiptRuleSet>(
  "AWS.SES.ActiveReceiptRuleSet",
  {
    displayName: "SES Active Receipt Rule Set",
    icon: "flag",
    color: "#E7157B",
    category: "email",
    summary: (ctx) => ctx.attrs?.ruleSetName,
    facts: (ctx) => [
      { label: "rule set", value: ctx.attrs?.ruleSetName, copy: true },
    ],
  },
);

export const ConfigurationSetUI = UIProvider.succeed<ConfigurationSet>(
  "AWS.SES.ConfigurationSet",
  {
    displayName: "SES Configuration Set",
    icon: "settings",
    color: "#E7157B",
    category: "email",
    summary: (ctx) => ctx.attrs?.configurationSetName,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.configurationSetArn);
      return ctx.attrs?.configurationSetName === undefined ||
        region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/ses/home?region=${region}#/configuration-sets/${encodeURIComponent(ctx.attrs.configurationSetName)}`;
    },
    facts: (ctx) => [
      {
        label: "configuration set",
        value: ctx.attrs?.configurationSetName,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.configurationSetArn,
        mono: true,
        copy: true,
      },
      { label: "sending enabled", value: ctx.props?.sendingEnabled },
      { label: "tls policy", value: ctx.props?.tlsPolicy },
    ],
  },
);

export const ConfigurationSetEventDestinationUI =
  UIProvider.succeed<ConfigurationSetEventDestination>(
    "AWS.SES.ConfigurationSetEventDestination",
    {
      displayName: "SES Event Destination",
      icon: "webhook",
      color: "#E7157B",
      category: "eventing",
      summary: (ctx) => ctx.attrs?.eventDestinationName,
      facts: (ctx) => [
        {
          label: "destination",
          value: ctx.attrs?.eventDestinationName,
          copy: true,
        },
        {
          label: "configuration set",
          value: ctx.attrs?.configurationSetName,
          copy: true,
        },
        { label: "enabled", value: ctx.props?.enabled },
        {
          label: "event types",
          value: ctx.props?.matchingEventTypes?.join(", "),
        },
      ],
    },
  );

export const EmailIdentityUI = UIProvider.succeed<EmailIdentity>(
  "AWS.SES.EmailIdentity",
  {
    displayName: "SES Email Identity",
    icon: "mail",
    color: "#E7157B",
    category: "email",
    summary: (ctx) => ctx.attrs?.emailIdentity,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.identityArn);
      return ctx.attrs?.emailIdentity === undefined || region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/ses/home?region=${region}#/verified-identities/${encodeURIComponent(ctx.attrs.emailIdentity)}`;
    },
    facts: (ctx) => [
      { label: "identity", value: ctx.attrs?.emailIdentity, copy: true },
      { label: "arn", value: ctx.attrs?.identityArn, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.identityType },
      { label: "verification", value: ctx.attrs?.verificationStatus },
      {
        label: "verified for sending",
        value: ctx.attrs?.verifiedForSendingStatus,
      },
      { label: "dkim status", value: ctx.attrs?.dkimStatus },
    ],
  },
);

export const EmailTemplateUI = UIProvider.succeed<EmailTemplate>(
  "AWS.SES.EmailTemplate",
  {
    displayName: "SES Email Template",
    icon: "file-text",
    color: "#E7157B",
    category: "email",
    summary: (ctx) => ctx.attrs?.templateName,
    facts: (ctx) => [
      { label: "template", value: ctx.attrs?.templateName, copy: true },
      { label: "arn", value: ctx.attrs?.templateArn, mono: true, copy: true },
      { label: "subject", value: ctx.props?.subject },
    ],
  },
);

export const ReceiptFilterUI = UIProvider.succeed<ReceiptFilter>(
  "AWS.SES.ReceiptFilter",
  {
    displayName: "SES Receipt Filter",
    icon: "filter",
    color: "#E7157B",
    category: "email",
    summary: (ctx) => ctx.attrs?.filterName,
    facts: (ctx) => [
      { label: "filter", value: ctx.attrs?.filterName, copy: true },
      { label: "policy", value: ctx.props?.ipFilter?.policy },
      { label: "cidr", value: ctx.props?.ipFilter?.cidr, mono: true },
    ],
  },
);

export const ReceiptRuleUI = UIProvider.succeed<ReceiptRule>(
  "AWS.SES.ReceiptRule",
  {
    displayName: "SES Receipt Rule",
    icon: "route",
    color: "#E7157B",
    category: "email",
    summary: (ctx) => ctx.attrs?.ruleName,
    facts: (ctx) => [
      { label: "rule", value: ctx.attrs?.ruleName, copy: true },
      { label: "rule set", value: ctx.attrs?.ruleSetName, copy: true },
      { label: "enabled", value: ctx.props?.enabled },
      { label: "recipients", value: ctx.props?.recipients?.length },
      { label: "actions", value: ctx.props?.actions?.length },
    ],
  },
);

export const ReceiptRuleSetUI = UIProvider.succeed<ReceiptRuleSet>(
  "AWS.SES.ReceiptRuleSet",
  {
    displayName: "SES Receipt Rule Set",
    icon: "list-ordered",
    color: "#E7157B",
    category: "email",
    summary: (ctx) => ctx.attrs?.ruleSetName,
    facts: (ctx) => [
      { label: "rule set", value: ctx.attrs?.ruleSetName, copy: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    ActiveReceiptRuleSetUI,
    ConfigurationSetUI,
    ConfigurationSetEventDestinationUI,
    EmailIdentityUI,
    EmailTemplateUI,
    ReceiptFilterUI,
    ReceiptRuleUI,
    ReceiptRuleSetUI,
  );
