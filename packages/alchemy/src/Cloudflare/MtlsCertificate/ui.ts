import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { MtlsCertificate } from "./MtlsCertificate.ts";

/**
 * Dashboard UI providers for Cloudflare mTLS Certificate resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const MtlsCertificateUI = UIProvider.succeed<MtlsCertificate>(
  "Cloudflare.MtlsCertificate.MtlsCertificate",
  {
    displayName: "mTLS Certificate",
    icon: "shield-check",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.mtlsCertificateId,
    consoleUrl: (ctx) =>
      ctx.attrs?.accountId === undefined
        ? undefined
        : `https://dash.cloudflare.com/${ctx.attrs.accountId}/mtls-certificates`,
    facts: (ctx) => [
      {
        label: "certificate id",
        value: ctx.attrs?.mtlsCertificateId,
        mono: true,
        copy: true,
      },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name },
      {
        label: "kind",
        value:
          ctx.attrs?.ca === undefined
            ? undefined
            : ctx.attrs.ca
              ? "CA"
              : "leaf",
      },
      { label: "issuer", value: ctx.attrs?.issuer },
      {
        label: "serial",
        value: ctx.attrs?.serialNumber,
        mono: true,
        copy: true,
      },
      { label: "expires", value: ctx.attrs?.expiresOn },
      { label: "uploaded", value: ctx.attrs?.uploadedOn },
    ],
  },
);

export const ui = () => Layer.mergeAll(MtlsCertificateUI);
