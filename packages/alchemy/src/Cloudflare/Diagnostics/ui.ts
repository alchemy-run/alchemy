import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { EndpointHealthcheck } from "./EndpointHealthcheck.ts";

/**
 * Dashboard UI providers for Cloudflare Diagnostics resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const EndpointHealthcheckUI = UIProvider.succeed<EndpointHealthcheck>(
  "Cloudflare.Diagnostics.EndpointHealthcheck",
  {
    displayName: "Endpoint Healthcheck",
    icon: "heart-pulse",
    color: "#F6821F",
    category: "observability",
    summary: (ctx) => ctx.attrs?.endpoint ?? ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "endpoint", value: ctx.attrs?.endpoint, mono: true, copy: true },
      { label: "check type", value: ctx.attrs?.checkType },
      {
        label: "healthcheck id",
        value: ctx.attrs?.healthcheckId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(EndpointHealthcheckUI);
