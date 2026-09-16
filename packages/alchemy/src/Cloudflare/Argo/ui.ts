import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { SmartRouting } from "./SmartRouting.ts";
import type { TieredCaching } from "./TieredCaching.ts";

/**
 * Dashboard UI providers for Cloudflare Argo resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const SmartRoutingUI = UIProvider.succeed<SmartRouting>(
  "Cloudflare.Argo.SmartRouting",
  {
    displayName: "Argo Smart Routing",
    icon: "route",
    color: "#F6821F",
    category: "network",
    summary: (ctx) =>
      ctx.attrs?.value === undefined
        ? ctx.attrs?.zoneId
        : `smart routing ${ctx.attrs.value}`,
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "value", value: ctx.attrs?.value },
      { label: "editable", value: ctx.attrs?.editable },
      { label: "initial value", value: ctx.attrs?.initialValue },
      { label: "modified", value: ctx.attrs?.modifiedOn, mono: true },
    ],
  },
);

export const TieredCachingUI = UIProvider.succeed<TieredCaching>(
  "Cloudflare.Argo.TieredCaching",
  {
    displayName: "Argo Tiered Caching",
    icon: "layers",
    color: "#F6821F",
    category: "cdn",
    summary: (ctx) =>
      ctx.attrs?.value === undefined
        ? ctx.attrs?.zoneId
        : `tiered caching ${ctx.attrs.value}`,
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "value", value: ctx.attrs?.value },
      { label: "editable", value: ctx.attrs?.editable },
      { label: "initial value", value: ctx.attrs?.initialValue },
      { label: "modified", value: ctx.attrs?.modifiedOn, mono: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(SmartRoutingUI, TieredCachingUI);
