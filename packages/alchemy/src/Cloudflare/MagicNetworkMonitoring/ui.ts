import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Config } from "./Config.ts";
import type { Rule } from "./Rule.ts";

/**
 * Dashboard UI providers for Cloudflare MagicNetworkMonitoring resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const ConfigUI = UIProvider.succeed<Config>(
  "Cloudflare.MagicNetworkMonitoring.Config",
  {
    displayName: "Network Monitoring Config",
    icon: "activity",
    color: "#F6821F",
    category: "observability",
    summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name ?? ctx.props?.name },
      {
        label: "default sampling",
        value: ctx.attrs?.defaultSampling ?? ctx.props?.defaultSampling,
        mono: true,
      },
      {
        label: "router ips",
        value: ctx.attrs?.routerIps?.length
          ? ctx.attrs.routerIps.join(", ")
          : undefined,
        mono: true,
      },
      {
        label: "warp devices",
        value: ctx.attrs?.warpDevices?.length,
      },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
    ],
  },
);

export const RuleUI = UIProvider.succeed<Rule>(
  "Cloudflare.MagicNetworkMonitoring.Rule",
  {
    displayName: "Network Monitoring Rule",
    icon: "siren",
    color: "#F6821F",
    category: "observability",
    summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
    facts: (ctx) => [
      { label: "rule id", value: ctx.attrs?.ruleId, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name ?? ctx.props?.name },
      { label: "type", value: ctx.attrs?.type ?? ctx.props?.type },
      {
        label: "prefixes",
        value: ctx.attrs?.prefixes?.length
          ? ctx.attrs.prefixes.join(", ")
          : undefined,
        mono: true,
      },
      {
        label: "bandwidth threshold",
        value: ctx.attrs?.bandwidthThreshold,
        mono: true,
      },
      {
        label: "packet threshold",
        value: ctx.attrs?.packetThreshold,
        mono: true,
      },
      { label: "duration", value: ctx.attrs?.duration },
      {
        label: "auto advertisement",
        value: ctx.attrs?.automaticAdvertisement,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(ConfigUI, RuleUI);
