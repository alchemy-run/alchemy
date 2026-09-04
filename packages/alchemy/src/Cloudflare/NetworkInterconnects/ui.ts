import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { NetworkInterconnectSettings } from "./Settings.ts";

/**
 * Dashboard UI providers for Cloudflare Network Interconnects resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const NetworkInterconnectSettingsUI =
  UIProvider.succeed<NetworkInterconnectSettings>(
    "Cloudflare.NetworkInterconnects.Settings",
    {
      displayName: "Interconnect Settings",
      icon: "cable",
      color: "#F6821F",
      category: "config",
      summary: (ctx) =>
        ctx.attrs?.defaultAsn === undefined
          ? undefined
          : `ASN ${ctx.attrs.defaultAsn}`,
      facts: (ctx) => [
        { label: "default ASN", value: ctx.attrs?.defaultAsn, mono: true },
        {
          label: "initial default ASN",
          value: ctx.attrs?.initialDefaultAsn,
          mono: true,
        },
        { label: "account", value: ctx.attrs?.accountId, mono: true },
      ],
    },
  );

export const ui = () => Layer.mergeAll(NetworkInterconnectSettingsUI);
