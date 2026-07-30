import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Group } from "./Group.ts";
import type { IdentityPool } from "./IdentityPool.ts";
import type { IdentityPoolRoleAttachment } from "./IdentityPoolRoleAttachment.ts";
import type { IdentityProvider } from "./IdentityProvider.ts";
import type { ResourceServer } from "./ResourceServer.ts";
import type { User } from "./User.ts";
import type { UserPool } from "./UserPool.ts";
import type { UserPoolClient } from "./UserPoolClient.ts";
import type { UserPoolDomain } from "./UserPoolDomain.ts";

/**
 * Dashboard UI providers for AWS Cognito resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** Cognito brand color (AWS Security, Identity & Compliance red). */
const COGNITO_COLOR = "#DD344C";

const regionOf = (arn: string | undefined) => arn?.split(":")[3];

export const UserPoolUI = UIProvider.succeed<UserPool>("AWS.Cognito.UserPool", {
  displayName: "Cognito User Pool",
  icon: "users",
  color: COGNITO_COLOR,
  category: "auth",
  summary: (ctx) => ctx.attrs?.userPoolName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.userPoolArn);
    return ctx.attrs?.userPoolId === undefined || region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/cognito/v2/idp/user-pools/${ctx.attrs.userPoolId}/user-pool-overview?region=${region}`;
  },
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.userPoolName, copy: true },
    { label: "id", value: ctx.attrs?.userPoolId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.userPoolArn, mono: true, copy: true },
    { label: "mfa", value: ctx.props?.mfaConfiguration },
    { label: "tier", value: ctx.props?.tier },
  ],
});

export const UserPoolClientUI = UIProvider.succeed<UserPoolClient>(
  "AWS.Cognito.UserPoolClient",
  {
    displayName: "Cognito User Pool Client",
    icon: "key-round",
    color: COGNITO_COLOR,
    category: "auth",
    summary: (ctx) => ctx.attrs?.clientName,
    facts: (ctx) => [
      { label: "client", value: ctx.attrs?.clientName, copy: true },
      {
        label: "client id",
        value: ctx.attrs?.clientId,
        mono: true,
        copy: true,
      },
      { label: "user pool", value: ctx.attrs?.userPoolId, mono: true },
      { label: "has secret", value: ctx.attrs?.clientSecret !== undefined },
      {
        label: "auth flows",
        value: ctx.props?.explicitAuthFlows?.join(", "),
      },
    ],
  },
);

export const UserPoolDomainUI = UIProvider.succeed<UserPoolDomain>(
  "AWS.Cognito.UserPoolDomain",
  {
    displayName: "Cognito User Pool Domain",
    icon: "globe",
    color: COGNITO_COLOR,
    category: "auth",
    summary: (ctx) => ctx.attrs?.domain,
    facts: (ctx) => [
      { label: "domain", value: ctx.attrs?.domain, copy: true },
      { label: "user pool", value: ctx.attrs?.userPoolId, mono: true },
      {
        label: "cloudfront domain",
        value: ctx.attrs?.cloudFrontDomain,
        mono: true,
        copy: true,
      },
      { label: "managed login version", value: ctx.props?.managedLoginVersion },
    ],
  },
);

export const GroupUI = UIProvider.succeed<Group>("AWS.Cognito.Group", {
  displayName: "Cognito Group",
  icon: "list-ordered",
  color: COGNITO_COLOR,
  category: "auth",
  summary: (ctx) => ctx.attrs?.groupName,
  facts: (ctx) => [
    { label: "group", value: ctx.attrs?.groupName, copy: true },
    { label: "user pool", value: ctx.attrs?.userPoolId, mono: true },
    { label: "role", value: ctx.props?.roleArn, mono: true },
    { label: "precedence", value: ctx.props?.precedence },
    { label: "description", value: ctx.props?.description },
  ],
});

export const UserUI = UIProvider.succeed<User>("AWS.Cognito.User", {
  displayName: "Cognito User",
  icon: "user",
  color: COGNITO_COLOR,
  category: "auth",
  summary: (ctx) => ctx.attrs?.username,
  facts: (ctx) => [
    { label: "username", value: ctx.attrs?.username, copy: true },
    { label: "user pool", value: ctx.attrs?.userPoolId, mono: true },
    { label: "sub", value: ctx.attrs?.sub, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.userStatus },
    { label: "enabled", value: ctx.props?.enabled },
  ],
});

export const IdentityPoolUI = UIProvider.succeed<IdentityPool>(
  "AWS.Cognito.IdentityPool",
  {
    displayName: "Cognito Identity Pool",
    icon: "fingerprint",
    color: COGNITO_COLOR,
    category: "auth",
    summary: (ctx) => ctx.attrs?.identityPoolName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.identityPoolName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.identityPoolId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.identityPoolArn,
        mono: true,
        copy: true,
      },
      {
        label: "unauthenticated",
        value: ctx.props?.allowUnauthenticatedIdentities,
      },
    ],
  },
);

export const IdentityPoolRoleAttachmentUI =
  UIProvider.succeed<IdentityPoolRoleAttachment>(
    "AWS.Cognito.IdentityPoolRoleAttachment",
    {
      displayName: "Cognito Identity Pool Role Attachment",
      icon: "link",
      color: COGNITO_COLOR,
      category: "auth",
      summary: (ctx) => ctx.attrs?.identityPoolId,
      facts: (ctx) => [
        {
          label: "identity pool",
          value: ctx.attrs?.identityPoolId,
          mono: true,
          copy: true,
        },
        {
          label: "authenticated role",
          value: ctx.attrs?.roles?.authenticated,
          mono: true,
        },
        {
          label: "unauthenticated role",
          value: ctx.attrs?.roles?.unauthenticated,
          mono: true,
        },
      ],
    },
  );

export const IdentityProviderUI = UIProvider.succeed<IdentityProvider>(
  "AWS.Cognito.IdentityProvider",
  {
    displayName: "Cognito Identity Provider",
    icon: "share-2",
    color: COGNITO_COLOR,
    category: "auth",
    summary: (ctx) => ctx.attrs?.providerName,
    facts: (ctx) => [
      { label: "provider", value: ctx.attrs?.providerName, copy: true },
      { label: "user pool", value: ctx.attrs?.userPoolId, mono: true },
      { label: "type", value: ctx.attrs?.providerType },
    ],
  },
);

export const ResourceServerUI = UIProvider.succeed<ResourceServer>(
  "AWS.Cognito.ResourceServer",
  {
    displayName: "Cognito Resource Server",
    icon: "server",
    color: COGNITO_COLOR,
    category: "auth",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.identifier,
    facts: (ctx) => [
      { label: "identifier", value: ctx.attrs?.identifier, copy: true },
      { label: "name", value: ctx.attrs?.name },
      { label: "user pool", value: ctx.attrs?.userPoolId, mono: true },
      { label: "scopes", value: ctx.props?.scopes?.length },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    UserPoolUI,
    UserPoolClientUI,
    UserPoolDomainUI,
    GroupUI,
    UserUI,
    IdentityPoolUI,
    IdentityPoolRoleAttachmentUI,
    IdentityProviderUI,
    ResourceServerUI,
  );
