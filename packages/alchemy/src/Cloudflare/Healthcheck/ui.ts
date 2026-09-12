import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Healthcheck } from "./Healthcheck.ts";

/**
 * Dashboard UI providers for Cloudflare Healthcheck resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no SDK code reaches the dashboard bundle.
 */
export const HealthcheckUI = UIProvider.succeed<Healthcheck>(
  "Cloudflare.Healthcheck.Healthcheck",
  {
    displayName: "Healthcheck",
    icon: "heart-pulse",
    color: "#F6821F",
    category: "observability",
    summary: (ctx) =>
      ctx.attrs?.name ?? ctx.attrs?.address ?? ctx.props?.address,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.healthcheckId, mono: true, copy: true },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "address", value: ctx.attrs?.address, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "status", value: ctx.attrs?.status },
      { label: "interval", value: ctx.attrs?.interval },
      { label: "suspended", value: ctx.attrs?.suspended },
    ],
  },
);

export const ui = () => Layer.mergeAll(HealthcheckUI);
