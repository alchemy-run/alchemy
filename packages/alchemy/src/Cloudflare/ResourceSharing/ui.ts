import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Share } from "./Share.ts";
import type { ShareRecipient } from "./ShareRecipient.ts";
import type { ShareResource } from "./ShareResource.ts";

/**
 * Dashboard UI providers for Cloudflare Resource Sharing resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const ShareUI = UIProvider.succeed<Share>(
  "Cloudflare.ResourceSharing.Share",
  {
    displayName: "Resource Share",
    icon: "share-2",
    color: "#F6821F",
    category: "config",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "share id", value: ctx.attrs?.shareId, mono: true, copy: true },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "target", value: ctx.attrs?.targetType },
      { label: "kind", value: ctx.attrs?.kind },
      { label: "org", value: ctx.attrs?.organizationId, mono: true },
    ],
  },
);

export const ShareRecipientUI = UIProvider.succeed<ShareRecipient>(
  "Cloudflare.ResourceSharing.ShareRecipient",
  {
    displayName: "Share Recipient",
    icon: "user-check",
    color: "#F6821F",
    category: "config",
    summary: (ctx) => ctx.attrs?.recipientAccountId ?? ctx.attrs?.recipientId,
    facts: (ctx) => [
      {
        label: "recipient id",
        value: ctx.attrs?.recipientId,
        mono: true,
        copy: true,
      },
      {
        label: "recipient account",
        value: ctx.attrs?.recipientAccountId,
        mono: true,
        copy: true,
      },
      { label: "share", value: ctx.attrs?.shareId, mono: true },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
      { label: "association", value: ctx.attrs?.associationStatus },
      { label: "created", value: ctx.attrs?.created },
    ],
  },
);

export const ShareResourceUI = UIProvider.succeed<ShareResource>(
  "Cloudflare.ResourceSharing.ShareResource",
  {
    displayName: "Share Resource",
    icon: "package",
    color: "#F6821F",
    category: "config",
    summary: (ctx) => ctx.attrs?.resourceId,
    facts: (ctx) => [
      {
        label: "id",
        value: ctx.attrs?.shareResourceId,
        mono: true,
        copy: true,
      },
      { label: "resource type", value: ctx.attrs?.resourceType },
      {
        label: "resource id",
        value: ctx.attrs?.resourceId,
        mono: true,
        copy: true,
      },
      {
        label: "resource account",
        value: ctx.attrs?.resourceAccountId,
        mono: true,
      },
      { label: "share", value: ctx.attrs?.shareId, mono: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "version", value: ctx.attrs?.resourceVersion },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(ShareUI, ShareRecipientUI, ShareResourceUI);
