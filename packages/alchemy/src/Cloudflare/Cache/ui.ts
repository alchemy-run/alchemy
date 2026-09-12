import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { OriginCloudRegion } from "./OriginCloudRegion.ts";
import type { RegionalTieredCache } from "./RegionalTieredCache.ts";
import type { Reserve } from "./Reserve.ts";
import type { SmartTieredCache } from "./SmartTieredCache.ts";
import type { Variants } from "./Variants.ts";

/**
 * Dashboard UI providers for Cloudflare Cache resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const ReserveUI = UIProvider.succeed<Reserve>(
  "Cloudflare.Cache.Reserve",
  {
    displayName: "Cache Reserve",
    icon: "hard-drive",
    color: "#F6821F",
    category: "cdn",
    summary: (ctx) =>
      ctx.attrs?.value === undefined
        ? ctx.attrs?.zoneId
        : `cache reserve ${ctx.attrs.value}`,
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "value", value: ctx.attrs?.value },
      { label: "editable", value: ctx.attrs?.editable },
      { label: "initial value", value: ctx.attrs?.initialValue },
      { label: "modified", value: ctx.attrs?.modifiedOn, mono: true },
      { label: "clear on delete", value: ctx.props?.clearOnDelete },
    ],
  },
);

export const SmartTieredCacheUI = UIProvider.succeed<SmartTieredCache>(
  "Cloudflare.Cache.SmartTieredCache",
  {
    displayName: "Smart Tiered Cache",
    icon: "layers",
    color: "#F6821F",
    category: "cdn",
    summary: (ctx) =>
      ctx.attrs?.value === undefined
        ? ctx.attrs?.zoneId
        : `smart tiered cache ${ctx.attrs.value}`,
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "value", value: ctx.attrs?.value },
      { label: "editable", value: ctx.attrs?.editable },
      { label: "initial value", value: ctx.attrs?.initialValue },
      { label: "modified", value: ctx.attrs?.modifiedOn, mono: true },
    ],
  },
);

export const RegionalTieredCacheUI = UIProvider.succeed<RegionalTieredCache>(
  "Cloudflare.Cache.RegionalTieredCache",
  {
    displayName: "Regional Tiered Cache",
    icon: "map",
    color: "#F6821F",
    category: "cdn",
    summary: (ctx) =>
      ctx.attrs?.value === undefined
        ? ctx.attrs?.zoneId
        : `regional tiered cache ${ctx.attrs.value}`,
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "value", value: ctx.attrs?.value },
      { label: "editable", value: ctx.attrs?.editable },
      { label: "initial value", value: ctx.attrs?.initialValue },
      { label: "modified", value: ctx.attrs?.modifiedOn, mono: true },
    ],
  },
);

export const VariantsUI = UIProvider.succeed<Variants>(
  "Cloudflare.Cache.Variants",
  {
    displayName: "Cache Variants",
    icon: "images",
    color: "#F6821F",
    category: "cdn",
    summary: (ctx) => ctx.attrs?.zoneId,
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      {
        label: "extensions",
        value: ctx.attrs?.value
          ? Object.keys(ctx.attrs.value).join(", ")
          : undefined,
        mono: true,
      },
      { label: "editable", value: ctx.attrs?.editable },
      { label: "modified", value: ctx.attrs?.modifiedOn, mono: true },
    ],
  },
);

export const OriginCloudRegionUI = UIProvider.succeed<OriginCloudRegion>(
  "Cloudflare.Cache.OriginCloudRegion",
  {
    displayName: "Origin Cloud Region",
    icon: "cloud",
    color: "#F6821F",
    category: "cdn",
    summary: (ctx) =>
      ctx.attrs?.vendor === undefined || ctx.attrs.region === undefined
        ? ctx.attrs?.originIp
        : `${ctx.attrs.vendor} ${ctx.attrs.region}`,
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      {
        label: "origin ip",
        value: ctx.attrs?.originIp,
        mono: true,
        copy: true,
      },
      { label: "vendor", value: ctx.attrs?.vendor },
      { label: "region", value: ctx.attrs?.region },
      { label: "modified", value: ctx.attrs?.modifiedOn, mono: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    ReserveUI,
    SmartTieredCacheUI,
    RegionalTieredCacheUI,
    VariantsUI,
    OriginCloudRegionUI,
  );
