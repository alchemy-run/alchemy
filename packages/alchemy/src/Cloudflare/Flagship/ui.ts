import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { App } from "./App.ts";
import type { Flag } from "./Flag.ts";

/**
 * Dashboard UI providers for Cloudflare Flagship (feature flags) resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const AppUI = UIProvider.succeed<App>("Cloudflare.Flagship.App", {
  displayName: "Flagship App",
  icon: "flag",
  color: "#F6821F",
  category: "config",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "app id", value: ctx.attrs?.appId, mono: true, copy: true },
    { label: "account", value: ctx.attrs?.accountId, mono: true },
    { label: "created", value: ctx.attrs?.createdAt },
    { label: "updated", value: ctx.attrs?.updatedAt },
  ],
});

export const FlagUI = UIProvider.succeed<Flag>("Cloudflare.Flagship.Flag", {
  displayName: "Feature Flag",
  icon: "toggle-right",
  color: "#F6821F",
  category: "config",
  summary: (ctx) => ctx.attrs?.key,
  facts: (ctx) => [
    { label: "key", value: ctx.attrs?.key, mono: true, copy: true },
    { label: "app", value: ctx.attrs?.appId, mono: true },
    { label: "enabled", value: ctx.attrs?.enabled },
    { label: "default variation", value: ctx.attrs?.defaultVariation },
    {
      label: "variations",
      value: ctx.attrs?.variations
        ? Object.keys(ctx.attrs.variations).join(", ")
        : undefined,
    },
    { label: "rules", value: ctx.attrs?.rules?.length },
    { label: "type", value: ctx.attrs?.type },
  ],
});

export const ui = () => Layer.mergeAll(AppUI, FlagUI);
