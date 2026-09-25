import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AccessKey } from "./AccessKey.ts";
import type { AccountAlias } from "./AccountAlias.ts";
import type { AccountPasswordPolicy } from "./AccountPasswordPolicy.ts";
import type { Group } from "./Group.ts";
import type { GroupMembership } from "./GroupMembership.ts";
import type { InstanceProfile } from "./InstanceProfile.ts";
import type { LoginProfile } from "./LoginProfile.ts";
import type { OpenIDConnectProvider } from "./OpenIDConnectProvider.ts";
import type { Policy } from "./Policy.ts";
import type { Role } from "./Role.ts";
import type { SAMLProvider } from "./SAMLProvider.ts";
import type { SSHPublicKey } from "./SSHPublicKey.ts";
import type { ServerCertificate } from "./ServerCertificate.ts";
import type { ServiceLinkedRole } from "./ServiceLinkedRole.ts";
import type { ServiceSpecificCredential } from "./ServiceSpecificCredential.ts";
import type { SigningCertificate } from "./SigningCertificate.ts";
import type { User } from "./User.ts";
import type { VirtualMFADevice } from "./VirtualMFADevice.ts";

/**
 * Dashboard UI providers for AWS IAM resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const IAM_RED = "#DD344C";

export const RoleUI = UIProvider.succeed<Role>("AWS.IAM.Role", {
  displayName: "IAM Role",
  icon: "user-cog",
  color: IAM_RED,
  category: "auth",
  summary: (ctx) => ctx.attrs?.roleName,
  consoleUrl: (ctx) =>
    ctx.attrs?.roleName === undefined
      ? undefined
      : `https://console.aws.amazon.com/iam/home#/roles/details/${ctx.attrs.roleName}`,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.roleName, copy: true },
    { label: "arn", value: ctx.attrs?.roleArn, mono: true, copy: true },
    { label: "id", value: ctx.attrs?.roleId, mono: true },
    { label: "path", value: ctx.attrs?.path },
    {
      label: "managed policies",
      value: ctx.attrs?.managedPolicyArns?.length,
    },
    {
      label: "inline policies",
      value:
        ctx.attrs?.inlinePolicies === undefined
          ? undefined
          : Object.keys(ctx.attrs.inlinePolicies).length,
    },
    { label: "max session", value: ctx.attrs?.maxSessionDuration },
    {
      label: "permissions boundary",
      value: ctx.attrs?.permissionsBoundary,
      mono: true,
    },
  ],
});

export const UserUI = UIProvider.succeed<User>("AWS.IAM.User", {
  displayName: "IAM User",
  icon: "user",
  color: IAM_RED,
  category: "auth",
  summary: (ctx) => ctx.attrs?.userName,
  consoleUrl: (ctx) =>
    ctx.attrs?.userName === undefined
      ? undefined
      : `https://console.aws.amazon.com/iam/home#/users/details/${ctx.attrs.userName}`,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.userName, copy: true },
    { label: "arn", value: ctx.attrs?.userArn, mono: true, copy: true },
    { label: "id", value: ctx.attrs?.userId, mono: true },
    { label: "path", value: ctx.attrs?.path },
    {
      label: "managed policies",
      value: ctx.attrs?.managedPolicyArns?.length,
    },
    {
      label: "permissions boundary",
      value: ctx.attrs?.permissionsBoundary,
      mono: true,
    },
  ],
});

export const GroupUI = UIProvider.succeed<Group>("AWS.IAM.Group", {
  displayName: "IAM Group",
  icon: "users",
  color: IAM_RED,
  category: "auth",
  summary: (ctx) => ctx.attrs?.groupName,
  consoleUrl: (ctx) =>
    ctx.attrs?.groupName === undefined
      ? undefined
      : `https://console.aws.amazon.com/iam/home#/groups/details/${ctx.attrs.groupName}`,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.groupName, copy: true },
    { label: "arn", value: ctx.attrs?.groupArn, mono: true, copy: true },
    { label: "id", value: ctx.attrs?.groupId, mono: true },
    { label: "path", value: ctx.attrs?.path },
    {
      label: "managed policies",
      value: ctx.attrs?.managedPolicyArns?.length,
    },
    {
      label: "inline policies",
      value:
        ctx.attrs?.inlinePolicies === undefined
          ? undefined
          : Object.keys(ctx.attrs.inlinePolicies).length,
    },
  ],
});

export const GroupMembershipUI = UIProvider.succeed<GroupMembership>(
  "AWS.IAM.GroupMembership",
  {
    displayName: "IAM Group Membership",
    icon: "user-plus",
    color: IAM_RED,
    category: "auth",
    summary: (ctx) => ctx.attrs?.groupName,
    facts: (ctx) => [
      { label: "group", value: ctx.attrs?.groupName, copy: true },
      { label: "members", value: ctx.attrs?.userNames?.length },
      { label: "users", value: ctx.attrs?.userNames?.join(", ") },
    ],
  },
);

export const PolicyUI = UIProvider.succeed<Policy>("AWS.IAM.Policy", {
  displayName: "IAM Policy",
  icon: "file-lock-2",
  color: IAM_RED,
  category: "security",
  summary: (ctx) => ctx.attrs?.policyName,
  consoleUrl: (ctx) =>
    ctx.attrs?.policyArn === undefined
      ? undefined
      : `https://console.aws.amazon.com/iam/home#/policies/details/${encodeURIComponent(ctx.attrs.policyArn)}`,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.policyName, copy: true },
    { label: "arn", value: ctx.attrs?.policyArn, mono: true, copy: true },
    { label: "id", value: ctx.attrs?.policyId, mono: true },
    { label: "path", value: ctx.attrs?.path },
    {
      label: "default version",
      value: ctx.attrs?.defaultVersionId,
      mono: true,
    },
    { label: "attachments", value: ctx.attrs?.attachmentCount },
    { label: "description", value: ctx.attrs?.description },
  ],
});

export const InstanceProfileUI = UIProvider.succeed<InstanceProfile>(
  "AWS.IAM.InstanceProfile",
  {
    displayName: "IAM Instance Profile",
    icon: "id-card",
    color: IAM_RED,
    category: "auth",
    summary: (ctx) => ctx.attrs?.instanceProfileName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.instanceProfileName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.instanceProfileArn,
        mono: true,
        copy: true,
      },
      { label: "id", value: ctx.attrs?.instanceProfileId, mono: true },
      { label: "role", value: ctx.attrs?.roleName, copy: true },
      { label: "path", value: ctx.attrs?.path },
    ],
  },
);

export const AccessKeyUI = UIProvider.succeed<AccessKey>("AWS.IAM.AccessKey", {
  displayName: "IAM Access Key",
  icon: "key-round",
  color: IAM_RED,
  category: "auth",
  summary: (ctx) => ctx.attrs?.accessKeyId,
  facts: (ctx) => [
    {
      label: "access key id",
      value: ctx.attrs?.accessKeyId,
      mono: true,
      copy: true,
    },
    { label: "user", value: ctx.attrs?.userName, copy: true },
    { label: "status", value: ctx.attrs?.status },
    {
      label: "created",
      value:
        ctx.attrs?.createDate === undefined
          ? undefined
          : String(ctx.attrs.createDate),
    },
    { label: "last used service", value: ctx.attrs?.lastUsedServiceName },
    { label: "last used region", value: ctx.attrs?.lastUsedRegion },
  ],
});

export const LoginProfileUI = UIProvider.succeed<LoginProfile>(
  "AWS.IAM.LoginProfile",
  {
    displayName: "IAM Login Profile",
    icon: "log-in",
    color: IAM_RED,
    category: "auth",
    summary: (ctx) => ctx.attrs?.userName,
    facts: (ctx) => [
      { label: "user", value: ctx.attrs?.userName, copy: true },
      {
        label: "password reset required",
        value: ctx.attrs?.passwordResetRequired,
      },
      {
        label: "created",
        value:
          ctx.attrs?.createDate === undefined
            ? undefined
            : String(ctx.attrs.createDate),
      },
    ],
  },
);

export const OpenIDConnectProviderUI =
  UIProvider.succeed<OpenIDConnectProvider>("AWS.IAM.OpenIDConnectProvider", {
    displayName: "IAM OIDC Provider",
    icon: "fingerprint",
    color: IAM_RED,
    category: "auth",
    summary: (ctx) => ctx.attrs?.url,
    consoleUrl: (ctx) =>
      ctx.attrs?.openIDConnectProviderArn === undefined
        ? undefined
        : `https://console.aws.amazon.com/iam/home#/identity_providers/details/OPENID/${encodeURIComponent(ctx.attrs.openIDConnectProviderArn)}`,
    facts: (ctx) => [
      {
        label: "url",
        value: ctx.attrs?.url,
        href:
          ctx.attrs?.url === undefined
            ? undefined
            : ctx.attrs.url.startsWith("http")
              ? ctx.attrs.url
              : `https://${ctx.attrs.url}`,
      },
      {
        label: "arn",
        value: ctx.attrs?.openIDConnectProviderArn,
        mono: true,
        copy: true,
      },
      { label: "client ids", value: ctx.attrs?.clientIDList?.join(", ") },
      { label: "thumbprints", value: ctx.attrs?.thumbprintList?.length },
    ],
  });

export const SAMLProviderUI = UIProvider.succeed<SAMLProvider>(
  "AWS.IAM.SAMLProvider",
  {
    displayName: "IAM SAML Provider",
    icon: "shield-check",
    color: IAM_RED,
    category: "auth",
    summary: (ctx) => ctx.attrs?.name,
    consoleUrl: (ctx) =>
      ctx.attrs?.samlProviderArn === undefined
        ? undefined
        : `https://console.aws.amazon.com/iam/home#/identity_providers/details/SAML/${encodeURIComponent(ctx.attrs.samlProviderArn)}`,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.samlProviderArn,
        mono: true,
        copy: true,
      },
      { label: "uuid", value: ctx.attrs?.samlProviderUUID, mono: true },
      {
        label: "assertion encryption",
        value: ctx.attrs?.assertionEncryptionMode,
      },
    ],
  },
);

export const ServerCertificateUI = UIProvider.succeed<ServerCertificate>(
  "AWS.IAM.ServerCertificate",
  {
    displayName: "IAM Server Certificate",
    icon: "file-badge",
    color: IAM_RED,
    category: "security",
    summary: (ctx) => ctx.attrs?.serverCertificateName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.serverCertificateName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.serverCertificateArn,
        mono: true,
        copy: true,
      },
      { label: "id", value: ctx.attrs?.serverCertificateId, mono: true },
      { label: "path", value: ctx.attrs?.path },
      {
        label: "expires",
        value:
          ctx.attrs?.expiration === undefined
            ? undefined
            : String(ctx.attrs.expiration),
      },
      {
        label: "uploaded",
        value:
          ctx.attrs?.uploadDate === undefined
            ? undefined
            : String(ctx.attrs.uploadDate),
      },
    ],
  },
);

export const SigningCertificateUI = UIProvider.succeed<SigningCertificate>(
  "AWS.IAM.SigningCertificate",
  {
    displayName: "IAM Signing Certificate",
    icon: "file-key-2",
    color: IAM_RED,
    category: "security",
    summary: (ctx) => ctx.attrs?.certificateId,
    facts: (ctx) => [
      {
        label: "certificate id",
        value: ctx.attrs?.certificateId,
        mono: true,
        copy: true,
      },
      { label: "user", value: ctx.attrs?.userName, copy: true },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "uploaded",
        value:
          ctx.attrs?.uploadDate === undefined
            ? undefined
            : String(ctx.attrs.uploadDate),
      },
    ],
  },
);

export const SSHPublicKeyUI = UIProvider.succeed<SSHPublicKey>(
  "AWS.IAM.SSHPublicKey",
  {
    displayName: "IAM SSH Public Key",
    icon: "key-square",
    color: IAM_RED,
    category: "auth",
    summary: (ctx) => ctx.attrs?.sshPublicKeyId,
    facts: (ctx) => [
      {
        label: "key id",
        value: ctx.attrs?.sshPublicKeyId,
        mono: true,
        copy: true,
      },
      { label: "user", value: ctx.attrs?.userName, copy: true },
      { label: "fingerprint", value: ctx.attrs?.fingerprint, mono: true },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "uploaded",
        value:
          ctx.attrs?.uploadDate === undefined
            ? undefined
            : String(ctx.attrs.uploadDate),
      },
    ],
  },
);

export const ServiceSpecificCredentialUI =
  UIProvider.succeed<ServiceSpecificCredential>(
    "AWS.IAM.ServiceSpecificCredential",
    {
      displayName: "IAM Service Credential",
      icon: "key",
      color: IAM_RED,
      category: "auth",
      summary: (ctx) => ctx.attrs?.serviceSpecificCredentialId,
      facts: (ctx) => [
        {
          label: "credential id",
          value: ctx.attrs?.serviceSpecificCredentialId,
          mono: true,
          copy: true,
        },
        { label: "user", value: ctx.attrs?.userName, copy: true },
        { label: "service", value: ctx.attrs?.serviceName },
        {
          label: "service user",
          value: ctx.attrs?.serviceUserName,
          mono: true,
        },
        { label: "status", value: ctx.attrs?.status },
        {
          label: "expires",
          value:
            ctx.attrs?.expirationDate === undefined
              ? undefined
              : String(ctx.attrs.expirationDate),
        },
      ],
    },
  );

export const VirtualMFADeviceUI = UIProvider.succeed<VirtualMFADevice>(
  "AWS.IAM.VirtualMFADevice",
  {
    displayName: "IAM Virtual MFA Device",
    icon: "smartphone",
    color: IAM_RED,
    category: "security",
    summary: (ctx) => ctx.attrs?.serialNumber,
    facts: (ctx) => [
      {
        label: "serial number",
        value: ctx.attrs?.serialNumber,
        mono: true,
        copy: true,
      },
      { label: "user", value: ctx.attrs?.userName, copy: true },
      {
        label: "enabled",
        value:
          ctx.attrs?.enableDate === undefined
            ? undefined
            : String(ctx.attrs.enableDate),
      },
    ],
  },
);

export const AccountAliasUI = UIProvider.succeed<AccountAlias>(
  "AWS.IAM.AccountAlias",
  {
    displayName: "IAM Account Alias",
    icon: "at-sign",
    color: IAM_RED,
    category: "config",
    summary: (ctx) => ctx.attrs?.accountAlias,
    link: (ctx) =>
      ctx.attrs?.accountAlias === undefined
        ? undefined
        : `https://${ctx.attrs.accountAlias}.signin.aws.amazon.com/console`,
    facts: (ctx) => [
      { label: "alias", value: ctx.attrs?.accountAlias, copy: true },
      {
        label: "sign-in url",
        value:
          ctx.attrs?.accountAlias === undefined
            ? undefined
            : `https://${ctx.attrs.accountAlias}.signin.aws.amazon.com/console`,
        href:
          ctx.attrs?.accountAlias === undefined
            ? undefined
            : `https://${ctx.attrs.accountAlias}.signin.aws.amazon.com/console`,
        copy: true,
      },
    ],
  },
);

export const AccountPasswordPolicyUI =
  UIProvider.succeed<AccountPasswordPolicy>("AWS.IAM.AccountPasswordPolicy", {
    displayName: "IAM Password Policy",
    icon: "lock-keyhole",
    color: IAM_RED,
    category: "security",
    summary: (ctx) =>
      ctx.attrs?.MinimumPasswordLength === undefined
        ? undefined
        : `min length ${ctx.attrs.MinimumPasswordLength}`,
    consoleUrl: () =>
      "https://console.aws.amazon.com/iam/home#/account_settings",
    facts: (ctx) => [
      { label: "min length", value: ctx.attrs?.MinimumPasswordLength },
      { label: "require symbols", value: ctx.attrs?.RequireSymbols },
      { label: "require numbers", value: ctx.attrs?.RequireNumbers },
      {
        label: "require uppercase",
        value: ctx.attrs?.RequireUppercaseCharacters,
      },
      {
        label: "require lowercase",
        value: ctx.attrs?.RequireLowercaseCharacters,
      },
      { label: "max age (days)", value: ctx.attrs?.MaxPasswordAge },
      { label: "reuse prevention", value: ctx.attrs?.PasswordReusePrevention },
    ],
  });

export const ServiceLinkedRoleUI = UIProvider.succeed<ServiceLinkedRole>(
  "AWS.IAM.ServiceLinkedRole",
  {
    displayName: "IAM Service-Linked Role",
    icon: "link",
    color: IAM_RED,
    category: "auth",
    summary: (ctx) => ctx.attrs?.roleName,
    consoleUrl: (ctx) =>
      ctx.attrs?.roleName === undefined
        ? undefined
        : `https://console.aws.amazon.com/iam/home#/roles/details/${ctx.attrs.roleName}`,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.roleName, copy: true },
      { label: "arn", value: ctx.attrs?.roleArn, mono: true, copy: true },
      { label: "id", value: ctx.attrs?.roleId, mono: true },
      { label: "service", value: ctx.attrs?.awsServiceName },
      { label: "suffix", value: ctx.attrs?.customSuffix },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    RoleUI,
    UserUI,
    GroupUI,
    GroupMembershipUI,
    PolicyUI,
    InstanceProfileUI,
    AccessKeyUI,
    LoginProfileUI,
    OpenIDConnectProviderUI,
    SAMLProviderUI,
    ServerCertificateUI,
    SigningCertificateUI,
    SSHPublicKeyUI,
    ServiceSpecificCredentialUI,
    VirtualMFADeviceUI,
    AccountAliasUI,
    AccountPasswordPolicyUI,
    ServiceLinkedRoleUI,
  );
