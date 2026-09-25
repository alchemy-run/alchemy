import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { UrlNormalization } from "./UrlNormalization.ts";

/**
 * Dashboard UI providers for Cloudflare URL Normalization resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const UrlNormalizationUI = UIProvider.succeed<UrlNormalization>(
  "Cloudflare.UrlNormalization.UrlNormalization",
  {
    displayName: "URL Normalization",
    icon: "link-2",
    color: "#F6821F",
    category: "network",
    summary: (ctx) =>
      ctx.attrs?.type === undefined || ctx.attrs.scope === undefined
        ? ctx.attrs?.zoneId
        : `${ctx.attrs.type} (${ctx.attrs.scope})`,
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "scope", value: ctx.attrs?.scope },
    ],
  },
);

export const ui = () => Layer.mergeAll(UrlNormalizationUI);
