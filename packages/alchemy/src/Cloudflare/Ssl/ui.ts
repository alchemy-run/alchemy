import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { CertificatePack } from "./CertificatePack.ts";
import type { UniversalSsl } from "./UniversalSsl.ts";

/**
 * Dashboard UI providers for Cloudflare SSL resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const CertificatePackUI = UIProvider.succeed<CertificatePack>(
  "Cloudflare.Ssl.CertificatePack",
  {
    displayName: "Certificate Pack",
    icon: "file-badge",
    color: "#F6821F",
    category: "security",
    summary: (ctx) =>
      ctx.attrs?.hosts?.join(", ") ?? ctx.attrs?.certificatePackId,
    facts: (ctx) => [
      {
        label: "pack id",
        value: ctx.attrs?.certificatePackId,
        mono: true,
        copy: true,
      },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "hosts", value: ctx.attrs?.hosts?.join(", ") },
      { label: "CA", value: ctx.attrs?.certificateAuthority },
      { label: "status", value: ctx.attrs?.status },
      { label: "validation", value: ctx.attrs?.validationMethod },
      { label: "validity (days)", value: ctx.attrs?.validityDays },
    ],
  },
);

export const UniversalSslUI = UIProvider.succeed<UniversalSsl>(
  "Cloudflare.Ssl.UniversalSsl",
  {
    displayName: "Universal SSL",
    icon: "lock",
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
      { label: "initial value", value: ctx.attrs?.initialEnabled },
    ],
  },
);

export const ui = () => Layer.mergeAll(CertificatePackUI, UniversalSslUI);
