import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { GoogleTagGateway } from "./GoogleTagGateway.ts";

/**
 * Dashboard UI providers for Cloudflare Google Tag Gateway resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const GoogleTagGatewayUI = UIProvider.succeed<GoogleTagGateway>(
  "Cloudflare.GoogleTagGateway.GoogleTagGateway",
  {
    displayName: "Google Tag Gateway",
    icon: "tag",
    color: "#F6821F",
    category: "observability",
    summary: (ctx) => ctx.attrs?.measurementId ?? ctx.attrs?.zoneId,
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      {
        label: "measurement id",
        value: ctx.attrs?.measurementId,
        mono: true,
        copy: true,
      },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "endpoint", value: ctx.attrs?.endpoint, mono: true },
      { label: "hide origin IP", value: ctx.attrs?.hideOriginalIp },
    ],
  },
);

export const ui = () => Layer.mergeAll(GoogleTagGatewayUI);
