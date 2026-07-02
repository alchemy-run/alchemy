import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Address } from "./Address.ts";
import type { AllowPolicy } from "./AllowPolicy.ts";
import type { BlockSender } from "./BlockSender.ts";
import type { CatchAll } from "./CatchAll.ts";
import type { Domain } from "./Domain.ts";
import type { ImpersonationRegistryEntry } from "./ImpersonationRegistryEntry.ts";
import type { Routing } from "./Routing.ts";
import type { Rule } from "./Rule.ts";
import type { SendingSubdomain } from "./SendingSubdomain.ts";
import type { TrustedDomain } from "./TrustedDomain.ts";

/**
 * Dashboard UI providers for Cloudflare Email resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no SDK code reaches the dashboard bundle.
 */
export const RoutingUI = UIProvider.succeed<Routing>(
  "Cloudflare.Email.Routing",
  {
    displayName: "Email Routing",
    icon: "mail",
    color: "#F6821F",
    category: "email",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "status", value: ctx.attrs?.status },
      { label: "zone id", value: ctx.attrs?.zoneId, mono: true, copy: true },
      {
        label: "routing id",
        value: ctx.attrs?.routingId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const AddressUI = UIProvider.succeed<Address>(
  "Cloudflare.Email.Address",
  {
    displayName: "Email Address",
    icon: "at-sign",
    color: "#F6821F",
    category: "email",
    summary: (ctx) => ctx.attrs?.email ?? ctx.props?.email,
    facts: (ctx) => [
      { label: "email", value: ctx.attrs?.email, copy: true },
      { label: "verified", value: ctx.attrs?.verified },
      { label: "verified at", value: ctx.attrs?.verifiedAt },
      {
        label: "address id",
        value: ctx.attrs?.addressId,
        mono: true,
        copy: true,
      },
      {
        label: "account id",
        value: ctx.attrs?.accountId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const RuleUI = UIProvider.succeed<Rule>("Cloudflare.Email.Rule", {
  displayName: "Email Rule",
  icon: "mail-check",
  color: "#F6821F",
  category: "email",
  summary: (ctx) => ctx.attrs?.name || ctx.attrs?.ruleId,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name },
    { label: "enabled", value: ctx.attrs?.enabled },
    { label: "priority", value: ctx.attrs?.priority },
    { label: "matchers", value: ctx.attrs?.matchers?.length },
    { label: "actions", value: ctx.attrs?.actions?.length },
    { label: "rule id", value: ctx.attrs?.ruleId, mono: true, copy: true },
    { label: "zone id", value: ctx.attrs?.zoneId, mono: true, copy: true },
  ],
});

export const CatchAllUI = UIProvider.succeed<CatchAll>(
  "Cloudflare.Email.CatchAll",
  {
    displayName: "Email Catch-All Rule",
    icon: "mail-question",
    color: "#F6821F",
    category: "email",
    summary: (ctx) => ctx.attrs?.name || ctx.attrs?.zoneId,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name },
      { label: "enabled", value: ctx.attrs?.enabled },
      {
        label: "actions",
        value: ctx.attrs?.actions?.map((a) => a.type).join(", "),
      },
      { label: "rule id", value: ctx.attrs?.ruleId, mono: true, copy: true },
      { label: "zone id", value: ctx.attrs?.zoneId, mono: true, copy: true },
    ],
  },
);

export const SendingSubdomainUI = UIProvider.succeed<SendingSubdomain>(
  "Cloudflare.Email.SendingSubdomain",
  {
    displayName: "Email Sending Subdomain",
    icon: "send",
    color: "#F6821F",
    category: "email",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "dkim selector", value: ctx.attrs?.dkimSelector, mono: true },
      { label: "return path", value: ctx.attrs?.returnPathDomain, mono: true },
      {
        label: "subdomain id",
        value: ctx.attrs?.subdomainId,
        mono: true,
        copy: true,
      },
      { label: "zone id", value: ctx.attrs?.zoneId, mono: true, copy: true },
    ],
  },
);

export const DomainUI = UIProvider.succeed<Domain>("Cloudflare.Email.Domain", {
  displayName: "Email Security Domain",
  icon: "shield-check",
  color: "#F6821F",
  category: "email",
  summary: (ctx) => ctx.attrs?.domain ?? ctx.props?.domain,
  facts: (ctx) => [
    { label: "domain", value: ctx.attrs?.domain, copy: true },
    { label: "transport", value: ctx.attrs?.transport, mono: true },
    { label: "authorized", value: ctx.attrs?.authorization?.authorized },
    {
      label: "delivery modes",
      value: ctx.attrs?.allowedDeliveryModes?.join(", "),
    },
    { label: "domain id", value: ctx.attrs?.domainId, mono: true, copy: true },
    {
      label: "account id",
      value: ctx.attrs?.accountId,
      mono: true,
      copy: true,
    },
  ],
});

export const TrustedDomainUI = UIProvider.succeed<TrustedDomain>(
  "Cloudflare.Email.TrustedDomain",
  {
    displayName: "Email Trusted Domain",
    icon: "shield",
    color: "#F6821F",
    category: "email",
    summary: (ctx) => ctx.attrs?.pattern ?? ctx.props?.pattern,
    facts: (ctx) => [
      { label: "pattern", value: ctx.attrs?.pattern, mono: true, copy: true },
      { label: "regex", value: ctx.attrs?.isRegex },
      { label: "recent", value: ctx.attrs?.isRecent },
      { label: "similarity", value: ctx.attrs?.isSimilarity },
      { label: "comments", value: ctx.attrs?.comments },
      {
        label: "id",
        value: ctx.attrs?.trustedDomainId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const BlockSenderUI = UIProvider.succeed<BlockSender>(
  "Cloudflare.Email.BlockSender",
  {
    displayName: "Email Blocked Sender",
    icon: "mail-x",
    color: "#F6821F",
    category: "email",
    summary: (ctx) => ctx.attrs?.pattern ?? ctx.props?.pattern,
    facts: (ctx) => [
      { label: "pattern", value: ctx.attrs?.pattern, mono: true, copy: true },
      { label: "pattern type", value: ctx.attrs?.patternType },
      { label: "regex", value: ctx.attrs?.isRegex },
      { label: "comments", value: ctx.attrs?.comments },
      { label: "id", value: ctx.attrs?.blockSenderId, mono: true, copy: true },
    ],
  },
);

export const AllowPolicyUI = UIProvider.succeed<AllowPolicy>(
  "Cloudflare.Email.AllowPolicy",
  {
    displayName: "Email Allow Policy",
    icon: "mail-open",
    color: "#F6821F",
    category: "email",
    summary: (ctx) => ctx.attrs?.pattern ?? ctx.props?.pattern,
    facts: (ctx) => [
      { label: "pattern", value: ctx.attrs?.pattern, mono: true, copy: true },
      { label: "pattern type", value: ctx.attrs?.patternType },
      { label: "acceptable sender", value: ctx.attrs?.isAcceptableSender },
      { label: "exempt recipient", value: ctx.attrs?.isExemptRecipient },
      { label: "trusted sender", value: ctx.attrs?.isTrustedSender },
      { label: "verify sender", value: ctx.attrs?.verifySender },
      { label: "id", value: ctx.attrs?.policyId, mono: true, copy: true },
    ],
  },
);

export const ImpersonationRegistryEntryUI =
  UIProvider.succeed<ImpersonationRegistryEntry>(
    "Cloudflare.Email.ImpersonationRegistryEntry",
    {
      displayName: "Impersonation Registry Entry",
      icon: "user-check",
      color: "#F6821F",
      category: "email",
      summary: (ctx) => ctx.attrs?.email ?? ctx.props?.email,
      facts: (ctx) => [
        { label: "name", value: ctx.attrs?.name },
        { label: "email", value: ctx.attrs?.email, copy: true },
        { label: "email regex", value: ctx.attrs?.isEmailRegex },
        { label: "provenance", value: ctx.attrs?.provenance },
        { label: "comments", value: ctx.attrs?.comments },
        { label: "id", value: ctx.attrs?.entryId, mono: true, copy: true },
      ],
    },
  );

export const ui = () =>
  Layer.mergeAll(
    RoutingUI,
    AddressUI,
    RuleUI,
    CatchAllUI,
    SendingSubdomainUI,
    DomainUI,
    TrustedDomainUI,
    BlockSenderUI,
    AllowPolicyUI,
    ImpersonationRegistryEntryUI,
  );
