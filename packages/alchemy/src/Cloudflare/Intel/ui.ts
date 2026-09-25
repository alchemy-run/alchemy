import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { IndicatorFeed } from "./IndicatorFeed.ts";
import type { IndicatorFeedPermission } from "./IndicatorFeedPermission.ts";

/**
 * Dashboard UI providers for Cloudflare Intel resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const IndicatorFeedUI = UIProvider.succeed<IndicatorFeed>(
  "Cloudflare.Intel.IndicatorFeed",
  {
    displayName: "Indicator Feed",
    icon: "rss",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "feed id", value: ctx.attrs?.feedId, mono: true, copy: true },
      { label: "description", value: ctx.attrs?.description },
      { label: "public", value: ctx.attrs?.isPublic },
      { label: "attributable", value: ctx.attrs?.isAttributable },
      { label: "downloadable", value: ctx.attrs?.isDownloadable },
      { label: "latest upload", value: ctx.attrs?.latestUploadStatus },
    ],
  },
);

export const IndicatorFeedPermissionUI =
  UIProvider.succeed<IndicatorFeedPermission>(
    "Cloudflare.Intel.IndicatorFeedPermission",
    {
      displayName: "Indicator Feed Permission",
      icon: "key-round",
      color: "#F6821F",
      category: "security",
      summary: (ctx) => ctx.attrs?.accountTag,
      facts: (ctx) => [
        { label: "feed id", value: ctx.attrs?.feedId, mono: true, copy: true },
        {
          label: "consumer account",
          value: ctx.attrs?.accountTag,
          mono: true,
          copy: true,
        },
        {
          label: "owner account",
          value: ctx.attrs?.accountId,
          mono: true,
          copy: true,
        },
      ],
    },
  );

export const ui = () =>
  Layer.mergeAll(IndicatorFeedUI, IndicatorFeedPermissionUI);
