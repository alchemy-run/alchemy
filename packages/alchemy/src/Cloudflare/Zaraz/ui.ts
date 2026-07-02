import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Config } from "./Config.ts";

/**
 * Dashboard UI providers for Cloudflare Zaraz resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const ConfigUI = UIProvider.succeed<Config>("Cloudflare.Zaraz.Config", {
  displayName: "Zaraz Config",
  icon: "tags",
  color: "#F6821F",
  category: "config",
  summary: (ctx) => ctx.attrs?.zoneId,
  facts: (ctx) => [
    { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
    { label: "version", value: ctx.attrs?.zarazVersion },
    { label: "data layer", value: ctx.attrs?.dataLayer },
    { label: "debug key", value: ctx.attrs?.debugKey, mono: true, copy: true },
    {
      label: "tools",
      value:
        ctx.attrs?.tools === undefined
          ? undefined
          : Object.keys(ctx.attrs.tools).length,
    },
    {
      label: "triggers",
      value:
        ctx.attrs?.triggers === undefined
          ? undefined
          : Object.keys(ctx.attrs.triggers).length,
    },
    {
      label: "variables",
      value:
        ctx.attrs?.variables === undefined
          ? undefined
          : Object.keys(ctx.attrs.variables).length,
    },
  ],
});

export const ui = () => Layer.mergeAll(ConfigUI);
