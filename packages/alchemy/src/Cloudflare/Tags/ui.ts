import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AccountResourceTags } from "./AccountResourceTags.ts";
import type { ZoneResourceTags } from "./ZoneResourceTags.ts";

/**
 * Dashboard UI providers for Cloudflare resource tagging resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const AccountResourceTagsUI = UIProvider.succeed<AccountResourceTags>(
  "Cloudflare.Tags.AccountResourceTags",
  {
    displayName: "Account Resource Tags",
    icon: "tags",
    color: "#F6821F",
    category: "config",
    summary: (ctx) =>
      ctx.attrs?.resourceType === undefined
        ? ctx.attrs?.resourceId
        : `${ctx.attrs.resourceType}/${ctx.attrs.resourceId ?? ""}`,
    facts: (ctx) => [
      { label: "resource type", value: ctx.attrs?.resourceType },
      {
        label: "resource id",
        value: ctx.attrs?.resourceId,
        mono: true,
        copy: true,
      },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
      { label: "worker", value: ctx.attrs?.workerId, mono: true },
      {
        label: "tags",
        value: ctx.attrs?.tags
          ? Object.entries(ctx.attrs.tags)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")
          : undefined,
        mono: true,
      },
      { label: "etag", value: ctx.attrs?.etag, mono: true },
    ],
  },
);

export const ZoneResourceTagsUI = UIProvider.succeed<ZoneResourceTags>(
  "Cloudflare.Tags.ZoneResourceTags",
  {
    displayName: "Zone Resource Tags",
    icon: "tag",
    color: "#F6821F",
    category: "config",
    summary: (ctx) =>
      ctx.attrs?.resourceType === undefined
        ? ctx.attrs?.resourceId
        : `${ctx.attrs.resourceType}/${ctx.attrs.resourceId ?? ""}`,
    facts: (ctx) => [
      { label: "resource type", value: ctx.attrs?.resourceType },
      {
        label: "resource id",
        value: ctx.attrs?.resourceId,
        mono: true,
        copy: true,
      },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      {
        label: "access app",
        value: ctx.attrs?.accessApplicationId,
        mono: true,
      },
      {
        label: "tags",
        value: ctx.attrs?.tags
          ? Object.entries(ctx.attrs.tags)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")
          : undefined,
        mono: true,
      },
      { label: "etag", value: ctx.attrs?.etag, mono: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(AccountResourceTagsUI, ZoneResourceTagsUI);
