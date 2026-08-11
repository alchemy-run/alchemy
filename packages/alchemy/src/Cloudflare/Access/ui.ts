import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Application } from "./Application.ts";
import type { Bookmark } from "./Bookmark.ts";
import type { Certificate } from "./Certificate.ts";
import type { CustomPage } from "./CustomPage.ts";
import type { Group } from "./Group.ts";
import type { IdentityProvider } from "./IdentityProvider.ts";
import type { InfrastructureTarget } from "./InfrastructureTarget.ts";
import type { KeyConfiguration } from "./KeyConfiguration.ts";
import type { McpPortal } from "./McpPortal.ts";
import type { Organization } from "./Organization.ts";
import type { Policy } from "./Policy.ts";
import type { ServiceToken } from "./ServiceToken.ts";
import type { Tag } from "./Tag.ts";

/**
 * Dashboard UI providers for Cloudflare Access (Zero Trust) resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const ApplicationUI = UIProvider.succeed<Application>(
  "Cloudflare.Access.Application",
  {
    displayName: "Access Application",
    icon: "shield-check",
    color: "#F6821F",
    category: "auth",
    summary: (ctx) => ctx.attrs?.name,
    link: (ctx) =>
      ctx.attrs?.domain ? `https://${ctx.attrs.domain}` : undefined,
    consoleUrl: (ctx) =>
      ctx.attrs?.accountId === undefined
        ? undefined
        : `https://one.dash.cloudflare.com/${ctx.attrs.accountId}/access/apps`,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.applicationId, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.type },
      {
        label: "domain",
        value: ctx.attrs?.domain,
        href: ctx.attrs?.domain ? `https://${ctx.attrs.domain}` : undefined,
      },
      { label: "aud", value: ctx.attrs?.aud, mono: true, copy: true },
      { label: "created", value: ctx.attrs?.createdAt },
    ],
  },
);

export const BookmarkUI = UIProvider.succeed<Bookmark>(
  "Cloudflare.Access.Bookmark",
  {
    displayName: "Access Bookmark",
    icon: "bookmark",
    color: "#F6821F",
    category: "auth",
    summary: (ctx) => ctx.attrs?.name,
    link: (ctx) =>
      ctx.attrs?.domain ? `https://${ctx.attrs.domain}` : undefined,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.bookmarkId, mono: true, copy: true },
      {
        label: "domain",
        value: ctx.attrs?.domain,
        href: ctx.attrs?.domain ? `https://${ctx.attrs.domain}` : undefined,
      },
      { label: "app launcher", value: ctx.attrs?.appLauncherVisible },
    ],
  },
);

export const CertificateUI = UIProvider.succeed<Certificate>(
  "Cloudflare.Access.Certificate",
  {
    displayName: "Access mTLS Certificate",
    icon: "file-lock-2",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.certificateId, mono: true, copy: true },
      { label: "fingerprint", value: ctx.attrs?.fingerprint, mono: true },
      {
        label: "hostnames",
        value: ctx.attrs?.associatedHostnames?.length
          ? ctx.attrs.associatedHostnames.join(", ")
          : undefined,
      },
      { label: "expires", value: ctx.attrs?.expiresOn },
    ],
  },
);

export const CustomPageUI = UIProvider.succeed<CustomPage>(
  "Cloudflare.Access.CustomPage",
  {
    displayName: "Access Custom Page",
    icon: "file-text",
    color: "#F6821F",
    category: "auth",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.customPageId, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
    ],
  },
);

export const GroupUI = UIProvider.succeed<Group>("Cloudflare.Access.Group", {
  displayName: "Access Group",
  icon: "users",
  color: "#F6821F",
  category: "auth",
  summary: (ctx) => ctx.attrs?.name,
  consoleUrl: (ctx) =>
    ctx.attrs?.accountId === undefined
      ? undefined
      : `https://one.dash.cloudflare.com/${ctx.attrs.accountId}/access/groups`,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.groupId, mono: true, copy: true },
    { label: "default", value: ctx.attrs?.isDefault },
    { label: "account", value: ctx.attrs?.accountId, mono: true },
  ],
});

export const IdentityProviderUI = UIProvider.succeed<IdentityProvider>(
  "Cloudflare.Access.IdentityProvider",
  {
    displayName: "Access Identity Provider",
    icon: "key-round",
    color: "#F6821F",
    category: "auth",
    summary: (ctx) => ctx.attrs?.name,
    consoleUrl: (ctx) =>
      ctx.attrs?.accountId === undefined
        ? undefined
        : `https://one.dash.cloudflare.com/${ctx.attrs.accountId}/settings/authentication`,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "id",
        value: ctx.attrs?.identityProviderId,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.type },
      { label: "scim", value: ctx.attrs?.scimEnabled },
      {
        label: "scim url",
        value: ctx.attrs?.scimBaseUrl,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const InfrastructureTargetUI = UIProvider.succeed<InfrastructureTarget>(
  "Cloudflare.Access.InfrastructureTarget",
  {
    displayName: "Access Infrastructure Target",
    icon: "server",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.hostname,
    facts: (ctx) => [
      { label: "hostname", value: ctx.attrs?.hostname, copy: true },
      { label: "id", value: ctx.attrs?.targetId, mono: true, copy: true },
      { label: "ipv4", value: ctx.attrs?.ip?.ipv4?.ipAddr, mono: true },
      { label: "ipv6", value: ctx.attrs?.ip?.ipv6?.ipAddr, mono: true },
      { label: "created", value: ctx.attrs?.createdAt },
    ],
  },
);

export const KeyConfigurationUI = UIProvider.succeed<KeyConfiguration>(
  "Cloudflare.Access.KeyConfiguration",
  {
    displayName: "Access Key Configuration",
    icon: "key-square",
    color: "#F6821F",
    category: "security",
    summary: (ctx) =>
      ctx.attrs?.keyRotationIntervalDays === undefined
        ? undefined
        : `rotate every ${ctx.attrs.keyRotationIntervalDays}d`,
    facts: (ctx) => [
      {
        label: "rotation interval (days)",
        value: ctx.attrs?.keyRotationIntervalDays,
      },
      {
        label: "days until next rotation",
        value: ctx.attrs?.daysUntilNextRotation,
      },
      { label: "last rotation", value: ctx.attrs?.lastKeyRotationAt },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
    ],
  },
);

export const McpPortalUI = UIProvider.succeed<McpPortal>(
  "Cloudflare.Access.McpPortal",
  {
    displayName: "Access MCP Portal",
    icon: "panels-top-left",
    color: "#F6821F",
    category: "auth",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.hostname,
    link: (ctx) =>
      ctx.attrs?.hostname ? `https://${ctx.attrs.hostname}` : undefined,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.portalId, mono: true, copy: true },
      {
        label: "hostname",
        value: ctx.attrs?.hostname,
        href: ctx.attrs?.hostname ? `https://${ctx.attrs.hostname}` : undefined,
      },
      { label: "code mode", value: ctx.attrs?.allowCodeMode },
      { label: "secure web gateway", value: ctx.attrs?.secureWebGateway },
    ],
  },
);

export const OrganizationUI = UIProvider.succeed<Organization>(
  "Cloudflare.Access.Organization",
  {
    displayName: "Zero Trust Organization",
    icon: "building-2",
    color: "#F6821F",
    category: "auth",
    summary: (ctx) => ctx.attrs?.authDomain ?? ctx.attrs?.name,
    link: (ctx) =>
      ctx.attrs?.authDomain ? `https://${ctx.attrs.authDomain}` : undefined,
    consoleUrl: (ctx) =>
      ctx.attrs?.accountId === undefined
        ? undefined
        : `https://one.dash.cloudflare.com/${ctx.attrs.accountId}/settings/general`,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "team domain",
        value: ctx.attrs?.authDomain,
        mono: true,
        copy: true,
      },
      { label: "session duration", value: ctx.attrs?.sessionDuration },
      {
        label: "auto redirect to IdP",
        value: ctx.attrs?.autoRedirectToIdentity,
      },
      { label: "warp auth", value: ctx.attrs?.allowAuthenticateViaWarp },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
    ],
  },
);

export const PolicyUI = UIProvider.succeed<Policy>("Cloudflare.Access.Policy", {
  displayName: "Access Policy",
  icon: "shield",
  color: "#F6821F",
  category: "auth",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.policyId, mono: true, copy: true },
    { label: "decision", value: ctx.attrs?.decision },
    { label: "created", value: ctx.attrs?.createdAt },
    { label: "updated", value: ctx.attrs?.updatedAt },
  ],
});

export const ServiceTokenUI = UIProvider.succeed<ServiceToken>(
  "Cloudflare.Access.ServiceToken",
  {
    displayName: "Access Service Token",
    icon: "key",
    color: "#F6821F",
    category: "auth",
    summary: (ctx) => ctx.attrs?.name,
    consoleUrl: (ctx) =>
      ctx.attrs?.accountId === undefined
        ? undefined
        : `https://one.dash.cloudflare.com/${ctx.attrs.accountId}/access/service-auth`,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.serviceTokenId, mono: true, copy: true },
      {
        label: "client id",
        value: ctx.attrs?.clientId,
        mono: true,
        copy: true,
      },
      { label: "duration", value: ctx.attrs?.duration },
      { label: "expires", value: ctx.attrs?.expiresAt },
      { label: "secret version", value: ctx.attrs?.clientSecretVersion },
    ],
  },
);

export const TagUI = UIProvider.succeed<Tag>("Cloudflare.Access.Tag", {
  displayName: "Access Tag",
  icon: "tag",
  color: "#F6821F",
  category: "auth",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "account", value: ctx.attrs?.accountId, mono: true },
  ],
});

export const ui = () =>
  Layer.mergeAll(
    ApplicationUI,
    BookmarkUI,
    CertificateUI,
    CustomPageUI,
    GroupUI,
    IdentityProviderUI,
    InfrastructureTargetUI,
    KeyConfigurationUI,
    McpPortalUI,
    OrganizationUI,
    PolicyUI,
    ServiceTokenUI,
    TagUI,
  );
