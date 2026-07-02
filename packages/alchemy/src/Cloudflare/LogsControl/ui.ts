import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { CmbConfig } from "./CmbConfig.ts";
import type { LogsRetentionFlag } from "./RetentionFlag.ts";

/**
 * Dashboard UI providers for Cloudflare Logs Control resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const CmbConfigUI = UIProvider.succeed<CmbConfig>(
  "Cloudflare.Logs.CmbConfig",
  {
    displayName: "Customer Metadata Boundary",
    icon: "globe-lock",
    color: "#F6821F",
    category: "config",
    summary: (ctx) => ctx.attrs?.regions,
    facts: (ctx) => [
      { label: "regions", value: ctx.attrs?.regions },
      {
        label: "out-of-region access",
        value: ctx.attrs?.allowOutOfRegionAccess,
      },
      {
        label: "account",
        value: ctx.attrs?.accountId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const LogsRetentionFlagUI = UIProvider.succeed<LogsRetentionFlag>(
  "Cloudflare.Logs.RetentionFlag",
  {
    displayName: "Logs Retention Flag",
    icon: "archive",
    color: "#F6821F",
    category: "observability",
    summary: (ctx) =>
      ctx.attrs?.flag === undefined
        ? undefined
        : ctx.attrs.flag
          ? "retention on"
          : "retention off",
    facts: (ctx) => [
      { label: "retention", value: ctx.attrs?.flag },
      { label: "initial", value: ctx.attrs?.initialFlag },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(CmbConfigUI, LogsRetentionFlagUI);
