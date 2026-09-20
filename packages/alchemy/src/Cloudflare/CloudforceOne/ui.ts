import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ScanConfig } from "./ScanConfig.ts";

/**
 * Dashboard UI providers for Cloudflare Cloudforce One resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const ScanConfigUI = UIProvider.succeed<ScanConfig>(
  "Cloudflare.CloudforceOne.ScanConfig",
  {
    displayName: "Attack Surface Scan Config",
    icon: "radar",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.ips?.join(", "),
    facts: (ctx) => [
      {
        label: "config id",
        value: ctx.attrs?.configId,
        mono: true,
        copy: true,
      },
      { label: "ips", value: ctx.attrs?.ips?.join(", "), mono: true },
      { label: "ports", value: ctx.attrs?.ports?.join(", "), mono: true },
      {
        label: "frequency",
        value:
          ctx.attrs?.frequency === undefined
            ? undefined
            : `every ${ctx.attrs.frequency} day(s)`,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(ScanConfigUI);
