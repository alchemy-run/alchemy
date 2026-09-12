import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { CustomTrustStore } from "./CustomTrustStore.ts";
import type { TotalTls } from "./TotalTls.ts";

/**
 * Dashboard UI providers for Cloudflare Advanced Certificate Manager
 * resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const TotalTlsUI = UIProvider.succeed<TotalTls>(
  "Cloudflare.Acm.TotalTls",
  {
    displayName: "Total TLS",
    icon: "shield-check",
    color: "#F6821F",
    category: "security",
    summary: (ctx) =>
      ctx.attrs?.enabled === undefined
        ? undefined
        : ctx.attrs.enabled
          ? "enabled"
          : "disabled",
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "CA", value: ctx.attrs?.certificateAuthority },
      { label: "validity (days)", value: ctx.attrs?.validityPeriod },
      { label: "initially enabled", value: ctx.attrs?.initialEnabled },
    ],
  },
);

export const CustomTrustStoreUI = UIProvider.succeed<CustomTrustStore>(
  "Cloudflare.Acm.CustomTrustStore",
  {
    displayName: "Custom Trust Store",
    icon: "file-lock-2",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.issuer ?? ctx.attrs?.id,
    facts: (ctx) => [
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "issuer", value: ctx.attrs?.issuer },
      { label: "status", value: ctx.attrs?.status },
      { label: "expires", value: ctx.attrs?.expiresOn },
      { label: "uploaded", value: ctx.attrs?.uploadedOn },
    ],
  },
);

export const ui = () => Layer.mergeAll(TotalTlsUI, CustomTrustStoreUI);
