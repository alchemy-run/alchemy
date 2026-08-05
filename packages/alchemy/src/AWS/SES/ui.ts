import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AccountSettings } from "./AccountSettings.ts";
import type { ActiveReceiptRuleSet } from "./ActiveReceiptRuleSet.ts";
import type { ConfigurationSet } from "./ConfigurationSet.ts";
import type { ConfigurationSetEventDestination } from "./ConfigurationSetEventDestination.ts";
import type { Contact } from "./Contact.ts";
import type { ContactList } from "./ContactList.ts";
import type { CustomVerificationEmailTemplate } from "./CustomVerificationEmailTemplate.ts";
import type { DedicatedIpPool } from "./DedicatedIpPool.ts";
import type { EmailIdentity } from "./EmailIdentity.ts";
import type { EmailIdentityPolicy } from "./EmailIdentityPolicy.ts";
import type { EmailTemplate } from "./EmailTemplate.ts";
import type { MultiRegionEndpoint } from "./MultiRegionEndpoint.ts";
import type { ReceiptFilter } from "./ReceiptFilter.ts";
import type { ReceiptRule } from "./ReceiptRule.ts";
import type { ReceiptRuleSet } from "./ReceiptRuleSet.ts";
import type { Tenant } from "./Tenant.ts";
import type { TenantResourceAssociation } from "./TenantResourceAssociation.ts";

/**
 * Dashboard UI providers for AWS SES resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined) => arn?.split(":")[3];

export const AccountSettingsUI = UIProvider.succeed<AccountSettings>(
  "AWS.SES.AccountSettings",
  {
    displayName: "SES Account Settings",
    icon: "sliders-horizontal",
    color: "#E7157B",
    category: "email",
    summary: (ctx) =>
      ctx.attrs === undefined
        ? undefined
        : ctx.attrs.sendingEnabled
          ? "sending enabled"
          : "sending paused",
    facts: (ctx) => [
      { label: "sending enabled", value: ctx.attrs?.sendingEnabled },
      { label: "vdm", value: ctx.attrs?.vdmEnabled },
      {
        label: "suppressed reasons",
        value: ctx.attrs?.suppressedReasons?.length
          ? ctx.attrs.suppressedReasons.join(", ")
          : undefined,
      },
    ],
  },
);

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

export const ContactUI = UIProvider.succeed<Contact>("AWS.SES.Contact", {
  displayName: "SES Contact",
  icon: "user-round",
  color: "#E7157B",
  category: "email",
  summary: (ctx) => ctx.attrs?.emailAddress,
  facts: (ctx) => [
    { label: "email", value: ctx.attrs?.emailAddress, copy: true },
    { label: "contact list", value: ctx.attrs?.contactListName, copy: true },
    { label: "unsubscribed from all", value: ctx.props?.unsubscribeAll },
    { label: "topic preferences", value: ctx.props?.topicPreferences?.length },
  ],
});

export const ContactListUI = UIProvider.succeed<ContactList>(
  "AWS.SES.ContactList",
  {
    displayName: "SES Contact List",
    icon: "users-round",
    color: "#E7157B",
    category: "email",
    summary: (ctx) => ctx.attrs?.contactListName,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.contactListArn);
      return ctx.attrs?.contactListName === undefined || region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/ses/home?region=${region}#/contact-lists/${encodeURIComponent(ctx.attrs.contactListName)}`;
    },
    facts: (ctx) => [
      { label: "contact list", value: ctx.attrs?.contactListName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.contactListArn,
        mono: true,
        copy: true,
      },
      { label: "description", value: ctx.props?.description },
      { label: "topics", value: ctx.props?.topics?.length },
    ],
  },
);

export const CustomVerificationEmailTemplateUI =
  UIProvider.succeed<CustomVerificationEmailTemplate>(
    "AWS.SES.CustomVerificationEmailTemplate",
    {
      displayName: "SES Verification Template",
      icon: "mail-check",
      color: "#E7157B",
      category: "email",
      summary: (ctx) => ctx.attrs?.templateName,
      facts: (ctx) => [
        { label: "template", value: ctx.attrs?.templateName, copy: true },
        { label: "from", value: ctx.props?.fromEmailAddress, copy: true },
        { label: "subject", value: ctx.props?.templateSubject },
        {
          label: "on success",
          value: ctx.props?.successRedirectionURL,
          href: ctx.props?.successRedirectionURL,
        },
        {
          label: "on failure",
          value: ctx.props?.failureRedirectionURL,
          href: ctx.props?.failureRedirectionURL,
        },
      ],
    },
  );

export const DedicatedIpPoolUI = UIProvider.succeed<DedicatedIpPool>(
  "AWS.SES.DedicatedIpPool",
  {
    displayName: "SES Dedicated IP Pool",
    icon: "server",
    color: "#E7157B",
    category: "network",
    summary: (ctx) => ctx.attrs?.poolName,
    facts: (ctx) => [
      { label: "pool", value: ctx.attrs?.poolName, copy: true },
      { label: "scaling mode", value: ctx.attrs?.scalingMode },
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

export const EmailIdentityPolicyUI = UIProvider.succeed<EmailIdentityPolicy>(
  "AWS.SES.EmailIdentityPolicy",
  {
    displayName: "SES Identity Policy",
    icon: "shield-check",
    color: "#E7157B",
    category: "security",
    summary: (ctx) => ctx.attrs?.policyName,
    facts: (ctx) => [
      { label: "policy", value: ctx.attrs?.policyName, copy: true },
      { label: "identity", value: ctx.attrs?.emailIdentity, copy: true },
      { label: "statements", value: ctx.props?.policy?.Statement?.length },
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

export const MultiRegionEndpointUI = UIProvider.succeed<MultiRegionEndpoint>(
  "AWS.SES.MultiRegionEndpoint",
  {
    displayName: "SES Multi-Region Endpoint",
    icon: "globe",
    color: "#E7157B",
    category: "network",
    summary: (ctx) => ctx.attrs?.endpointName,
    facts: (ctx) => [
      { label: "endpoint", value: ctx.attrs?.endpointName, copy: true },
      { label: "id", value: ctx.attrs?.endpointId, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "regions", value: ctx.props?.regions?.join(", ") },
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

export const TenantUI = UIProvider.succeed<Tenant>("AWS.SES.Tenant", {
  displayName: "SES Tenant",
  icon: "building-2",
  color: "#E7157B",
  category: "email",
  summary: (ctx) => ctx.attrs?.tenantName,
  facts: (ctx) => [
    { label: "tenant", value: ctx.attrs?.tenantName, copy: true },
    { label: "id", value: ctx.attrs?.tenantId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.tenantArn, mono: true, copy: true },
  ],
});

export const TenantResourceAssociationUI =
  UIProvider.succeed<TenantResourceAssociation>(
    "AWS.SES.TenantResourceAssociation",
    {
      displayName: "SES Tenant Association",
      icon: "link",
      color: "#E7157B",
      category: "email",
      summary: (ctx) => ctx.attrs?.tenantName,
      facts: (ctx) => [
        { label: "tenant", value: ctx.attrs?.tenantName, copy: true },
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
    AccountSettingsUI,
    ActiveReceiptRuleSetUI,
    ConfigurationSetUI,
    ConfigurationSetEventDestinationUI,
    ContactUI,
    ContactListUI,
    CustomVerificationEmailTemplateUI,
    DedicatedIpPoolUI,
    EmailIdentityUI,
    EmailIdentityPolicyUI,
    EmailTemplateUI,
    MultiRegionEndpointUI,
    ReceiptFilterUI,
    ReceiptRuleUI,
    ReceiptRuleSetUI,
    TenantUI,
    TenantResourceAssociationUI,
  );
