import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { CustomCertificate } from "./CustomCertificate.ts";

/**
 * Dashboard UI providers for Cloudflare Custom Certificate resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const CustomCertificateUI = UIProvider.succeed<CustomCertificate>(
  "Cloudflare.CustomCertificate.CustomCertificate",
  {
    displayName: "Custom Certificate",
    icon: "file-badge",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.hosts?.join(", ") ?? ctx.attrs?.certificateId,
    facts: (ctx) => [
      {
        label: "certificate id",
        value: ctx.attrs?.certificateId,
        mono: true,
        copy: true,
      },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "hosts", value: ctx.attrs?.hosts?.join(", ") },
      { label: "issuer", value: ctx.attrs?.issuer },
      { label: "status", value: ctx.attrs?.status },
      { label: "type", value: ctx.attrs?.type },
      { label: "bundle method", value: ctx.attrs?.bundleMethod },
      { label: "expires", value: ctx.attrs?.expiresOn },
    ],
  },
);

export const ui = () => Layer.mergeAll(CustomCertificateUI);
