import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { OriginCaCertificate } from "./OriginCaCertificate.ts";

/**
 * Dashboard UI providers for Cloudflare Origin CA Certificate resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const OriginCaCertificateUI = UIProvider.succeed<OriginCaCertificate>(
  "Cloudflare.OriginCaCertificate.OriginCaCertificate",
  {
    displayName: "Origin CA Certificate",
    icon: "file-key",
    color: "#F6821F",
    category: "security",
    summary: (ctx) =>
      ctx.attrs?.hostnames?.join(", ") ?? ctx.attrs?.certificateId,
    facts: (ctx) => [
      {
        label: "certificate id",
        value: ctx.attrs?.certificateId,
        mono: true,
        copy: true,
      },
      { label: "hostnames", value: ctx.attrs?.hostnames?.join(", ") },
      { label: "request type", value: ctx.attrs?.requestType },
      { label: "validity (days)", value: ctx.attrs?.requestedValidity },
      { label: "expires", value: ctx.attrs?.expiresOn },
    ],
  },
);

export const ui = () => Layer.mergeAll(OriginCaCertificateUI);
