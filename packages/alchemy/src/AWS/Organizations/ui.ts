import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Account } from "./Account.ts";
import type { DelegatedAdministrator } from "./DelegatedAdministrator.ts";
import type { Organization } from "./Organization.ts";
import type { OrganizationResourcePolicy } from "./OrganizationResourcePolicy.ts";
import type { OrganizationalUnit } from "./OrganizationalUnit.ts";
import type { Policy } from "./Policy.ts";
import type { PolicyAttachment } from "./PolicyAttachment.ts";
import type { Root } from "./Root.ts";
import type { RootPolicyType } from "./RootPolicyType.ts";
import type { TrustedServiceAccess } from "./TrustedServiceAccess.ts";

/**
 * Dashboard UI providers for AWS Organizations resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */
export const OrganizationUI = UIProvider.succeed<Organization>(
  "AWS.Organizations.Organization",
  {
    displayName: "Organization",
    icon: "network",
    color: "#E7157B",
    category: "config",
    summary: (ctx) => ctx.attrs?.organizationId,
    consoleUrl: () =>
      "https://console.aws.amazon.com/organizations/v2/home/accounts",
    facts: (ctx) => [
      { label: "id", value: ctx.attrs?.organizationId, mono: true, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.organizationArn,
        mono: true,
        copy: true,
      },
      { label: "feature set", value: ctx.attrs?.featureSet },
      {
        label: "management account",
        value: ctx.attrs?.managementAccountId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const AccountUI = UIProvider.succeed<Account>(
  "AWS.Organizations.Account",
  {
    displayName: "Organizations Account",
    icon: "landmark",
    color: "#E7157B",
    category: "config",
    summary: (ctx) => ctx.attrs?.accountId,
    consoleUrl: (ctx) =>
      ctx.attrs?.accountId === undefined
        ? undefined
        : `https://console.aws.amazon.com/organizations/v2/home/accounts/${ctx.attrs.accountId}`,
    facts: (ctx) => [
      {
        label: "account id",
        value: ctx.attrs?.accountId,
        mono: true,
        copy: true,
      },
      { label: "arn", value: ctx.attrs?.accountArn, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "parent", value: ctx.attrs?.parentId, mono: true },
    ],
  },
);

export const OrganizationalUnitUI = UIProvider.succeed<OrganizationalUnit>(
  "AWS.Organizations.OrganizationalUnit",
  {
    displayName: "Organizational Unit",
    icon: "folder-tree",
    color: "#E7157B",
    category: "config",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.ouId,
    consoleUrl: (ctx) =>
      ctx.attrs?.ouId === undefined
        ? undefined
        : `https://console.aws.amazon.com/organizations/v2/home/accounts/${ctx.attrs.ouId}`,
    facts: (ctx) => [
      { label: "ou id", value: ctx.attrs?.ouId, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.ouArn, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name },
      { label: "parent", value: ctx.attrs?.parentId, mono: true },
    ],
  },
);

export const PolicyUI = UIProvider.succeed<Policy>("AWS.Organizations.Policy", {
  displayName: "Organizations Policy",
  icon: "scroll-text",
  color: "#E7157B",
  category: "security",
  summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.policyId,
  facts: (ctx) => [
    {
      label: "policy id",
      value: ctx.attrs?.policyId,
      mono: true,
      copy: true,
    },
    { label: "arn", value: ctx.attrs?.policyArn, mono: true, copy: true },
    { label: "name", value: ctx.attrs?.name },
    { label: "type", value: ctx.attrs?.type },
    { label: "aws managed", value: ctx.attrs?.awsManaged },
    { label: "description", value: ctx.attrs?.description },
  ],
});

export const PolicyAttachmentUI = UIProvider.succeed<PolicyAttachment>(
  "AWS.Organizations.PolicyAttachment",
  {
    displayName: "Policy Attachment",
    icon: "paperclip",
    color: "#E7157B",
    category: "security",
    summary: (ctx) =>
      ctx.attrs?.policyId === undefined || ctx.attrs?.targetId === undefined
        ? (ctx.attrs?.policyId ?? ctx.attrs?.targetId)
        : `${ctx.attrs.policyId} → ${ctx.attrs.targetId}`,
    facts: (ctx) => [
      { label: "policy", value: ctx.attrs?.policyId, mono: true, copy: true },
      { label: "target", value: ctx.attrs?.targetId, mono: true, copy: true },
      { label: "target name", value: ctx.attrs?.targetName },
      { label: "target type", value: ctx.attrs?.targetType },
    ],
  },
);

export const RootUI = UIProvider.succeed<Root>("AWS.Organizations.Root", {
  displayName: "Organizations Root",
  icon: "git-branch",
  color: "#E7157B",
  category: "config",
  summary: (ctx) => ctx.attrs?.rootName ?? ctx.attrs?.rootId,
  facts: (ctx) => [
    { label: "root id", value: ctx.attrs?.rootId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.rootArn, mono: true, copy: true },
    { label: "name", value: ctx.attrs?.rootName },
    {
      label: "policy types",
      value: ctx.attrs?.policyTypes
        ?.map((p) => p.Type)
        .filter((t) => t !== undefined)
        .join(", "),
    },
  ],
});

export const RootPolicyTypeUI = UIProvider.succeed<RootPolicyType>(
  "AWS.Organizations.RootPolicyType",
  {
    displayName: "Root Policy Type",
    icon: "toggle-right",
    color: "#E7157B",
    category: "security",
    summary: (ctx) => ctx.attrs?.policyType,
    facts: (ctx) => [
      { label: "root", value: ctx.attrs?.rootId, mono: true, copy: true },
      { label: "policy type", value: ctx.attrs?.policyType },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const DelegatedAdministratorUI =
  UIProvider.succeed<DelegatedAdministrator>(
    "AWS.Organizations.DelegatedAdministrator",
    {
      displayName: "Delegated Administrator",
      icon: "user-cog",
      color: "#E7157B",
      category: "security",
      summary: (ctx) => ctx.attrs?.accountId,
      facts: (ctx) => [
        {
          label: "account id",
          value: ctx.attrs?.accountId,
          mono: true,
          copy: true,
        },
        {
          label: "service principal",
          value: ctx.attrs?.servicePrincipal,
          mono: true,
        },
      ],
    },
  );

export const TrustedServiceAccessUI = UIProvider.succeed<TrustedServiceAccess>(
  "AWS.Organizations.TrustedServiceAccess",
  {
    displayName: "Trusted Service Access",
    icon: "handshake",
    color: "#E7157B",
    category: "security",
    summary: (ctx) => ctx.attrs?.servicePrincipal,
    facts: (ctx) => [
      {
        label: "service principal",
        value: ctx.attrs?.servicePrincipal,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const OrganizationResourcePolicyUI =
  UIProvider.succeed<OrganizationResourcePolicy>(
    "AWS.Organizations.OrganizationResourcePolicy",
    {
      displayName: "Organization Resource Policy",
      icon: "file-lock-2",
      color: "#E7157B",
      category: "security",
      summary: (ctx) => ctx.attrs?.resourcePolicyId,
      facts: (ctx) => [
        {
          label: "policy id",
          value: ctx.attrs?.resourcePolicyId,
          mono: true,
          copy: true,
        },
        {
          label: "arn",
          value: ctx.attrs?.resourcePolicyArn,
          mono: true,
          copy: true,
        },
      ],
    },
  );

export const ui = () =>
  Layer.mergeAll(
    OrganizationUI,
    AccountUI,
    OrganizationalUnitUI,
    PolicyUI,
    PolicyAttachmentUI,
    RootUI,
    RootPolicyTypeUI,
    DelegatedAdministratorUI,
    TrustedServiceAccessUI,
    OrganizationResourcePolicyUI,
  );
