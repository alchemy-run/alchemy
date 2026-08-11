import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Permission } from "./Permission.ts";
import type { ResourceShare } from "./ResourceShare.ts";

/**
 * Dashboard UI providers for AWS RAM resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS management & governance brand pink. */
const COLOR = "#E7157B";

export const PermissionUI = UIProvider.succeed<Permission>(
  "AWS.RAM.Permission",
  {
    displayName: "RAM Permission",
    icon: "key-round",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "arn", value: ctx.attrs?.permissionArn, mono: true, copy: true },
      { label: "resource type", value: ctx.attrs?.resourceType, mono: true },
      { label: "version", value: ctx.attrs?.version },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const ResourceShareUI = UIProvider.succeed<ResourceShare>(
  "AWS.RAM.ResourceShare",
  {
    displayName: "RAM Resource Share",
    icon: "share-2",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.resourceShareArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "owning account",
        value: ctx.attrs?.owningAccountId,
        mono: true,
      },
      {
        label: "allow external principals",
        value: ctx.attrs?.allowExternalPrincipals,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(PermissionUI, ResourceShareUI);
