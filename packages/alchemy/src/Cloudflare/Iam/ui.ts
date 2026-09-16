import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ResourceGroup } from "./ResourceGroup.ts";
import type { UserGroup } from "./UserGroup.ts";
import type { UserGroupMembership } from "./UserGroupMembership.ts";

/**
 * Dashboard UI providers for Cloudflare IAM resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const ResourceGroupUI = UIProvider.succeed<ResourceGroup>(
  "Cloudflare.Iam.ResourceGroup",
  {
    displayName: "IAM Resource Group",
    icon: "boxes",
    color: "#F6821F",
    category: "auth",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "id",
        value: ctx.attrs?.resourceGroupId,
        mono: true,
        copy: true,
      },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
      { label: "scope key", value: ctx.attrs?.scope?.key, mono: true },
      { label: "objects", value: ctx.attrs?.scope?.objects?.length },
    ],
  },
);

export const UserGroupUI = UIProvider.succeed<UserGroup>(
  "Cloudflare.Iam.UserGroup",
  {
    displayName: "IAM User Group",
    icon: "users",
    color: "#F6821F",
    category: "auth",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.userGroupId, mono: true, copy: true },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
      { label: "policies", value: ctx.attrs?.policies?.length },
      { label: "created", value: ctx.attrs?.createdOn },
      { label: "modified", value: ctx.attrs?.modifiedOn },
    ],
  },
);

export const UserGroupMembershipUI = UIProvider.succeed<UserGroupMembership>(
  "Cloudflare.Iam.UserGroupMembership",
  {
    displayName: "IAM User Group Membership",
    icon: "user-plus",
    color: "#F6821F",
    category: "auth",
    summary: (ctx) => ctx.attrs?.email ?? ctx.attrs?.memberId,
    facts: (ctx) => [
      { label: "email", value: ctx.attrs?.email, copy: true },
      { label: "member", value: ctx.attrs?.memberId, mono: true, copy: true },
      {
        label: "user group",
        value: ctx.attrs?.userGroupId,
        mono: true,
        copy: true,
      },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(ResourceGroupUI, UserGroupUI, UserGroupMembershipUI);
