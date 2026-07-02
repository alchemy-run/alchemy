import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AccountAssignment } from "./AccountAssignment.ts";
import type { Group } from "./Group.ts";
import type { Instance } from "./Instance.ts";
import type { PermissionSet } from "./PermissionSet.ts";

/**
 * Dashboard UI providers for AWS IAM Identity Center resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const IDENTITY_RED = "#DD344C";

export const InstanceUI = UIProvider.succeed<Instance>(
  "AWS.IdentityCenter.Instance",
  {
    displayName: "Identity Center Instance",
    icon: "building-2",
    color: IDENTITY_RED,
    category: "auth",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.identityStoreId,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name },
      { label: "arn", value: ctx.attrs?.instanceArn, mono: true, copy: true },
      {
        label: "identity store",
        value: ctx.attrs?.identityStoreId,
        mono: true,
        copy: true,
      },
      { label: "owner account", value: ctx.attrs?.ownerAccountId, mono: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "mode", value: ctx.attrs?.mode },
      {
        label: "created",
        value:
          ctx.attrs?.createdDate === undefined
            ? undefined
            : String(ctx.attrs.createdDate),
      },
    ],
  },
);

export const PermissionSetUI = UIProvider.succeed<PermissionSet>(
  "AWS.IdentityCenter.PermissionSet",
  {
    displayName: "Permission Set",
    icon: "shield",
    color: IDENTITY_RED,
    category: "auth",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.permissionSetArn,
        mono: true,
        copy: true,
      },
      {
        label: "instance arn",
        value: ctx.attrs?.instanceArn,
        mono: true,
        copy: true,
      },
      { label: "session duration", value: ctx.attrs?.sessionDuration },
      { label: "relay state", value: ctx.attrs?.relayState },
      { label: "description", value: ctx.attrs?.description },
      {
        label: "created",
        value:
          ctx.attrs?.createdDate === undefined
            ? undefined
            : String(ctx.attrs.createdDate),
      },
    ],
  },
);

export const GroupUI = UIProvider.succeed<Group>("AWS.IdentityCenter.Group", {
  displayName: "Identity Center Group",
  icon: "users",
  color: IDENTITY_RED,
  category: "auth",
  summary: (ctx) => ctx.attrs?.displayName ?? ctx.attrs?.groupId,
  facts: (ctx) => [
    { label: "display name", value: ctx.attrs?.displayName, copy: true },
    { label: "group id", value: ctx.attrs?.groupId, mono: true, copy: true },
    {
      label: "identity store",
      value: ctx.attrs?.identityStoreId,
      mono: true,
      copy: true,
    },
    { label: "description", value: ctx.attrs?.description },
    {
      label: "created",
      value:
        ctx.attrs?.createdAt === undefined
          ? undefined
          : String(ctx.attrs.createdAt),
    },
  ],
});

export const AccountAssignmentUI = UIProvider.succeed<AccountAssignment>(
  "AWS.IdentityCenter.AccountAssignment",
  {
    displayName: "Account Assignment",
    icon: "link",
    color: IDENTITY_RED,
    category: "auth",
    summary: (ctx) =>
      ctx.attrs?.principalId === undefined || ctx.attrs?.targetId === undefined
        ? undefined
        : `${ctx.attrs.principalType ?? "principal"} ${ctx.attrs.principalId} → ${ctx.attrs.targetId}`,
    facts: (ctx) => [
      {
        label: "principal id",
        value: ctx.attrs?.principalId,
        mono: true,
        copy: true,
      },
      { label: "principal type", value: ctx.attrs?.principalType },
      {
        label: "target account",
        value: ctx.attrs?.targetId,
        mono: true,
        copy: true,
      },
      {
        label: "permission set",
        value: ctx.attrs?.permissionSetArn,
        mono: true,
        copy: true,
      },
      {
        label: "instance arn",
        value: ctx.attrs?.instanceArn,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(InstanceUI, PermissionSetUI, GroupUI, AccountAssignmentUI);
