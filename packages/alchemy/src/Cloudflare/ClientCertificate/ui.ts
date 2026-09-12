import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ClientCertificate } from "./ClientCertificate.ts";

/**
 * Dashboard UI providers for Cloudflare Client Certificate resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const ClientCertificateUI = UIProvider.succeed<ClientCertificate>(
  "Cloudflare.ClientCertificate.ClientCertificate",
  {
    displayName: "Client Certificate",
    icon: "file-key-2",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.commonName ?? ctx.attrs?.clientCertificateId,
    facts: (ctx) => [
      {
        label: "certificate id",
        value: ctx.attrs?.clientCertificateId,
        mono: true,
        copy: true,
      },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "common name", value: ctx.attrs?.commonName },
      { label: "status", value: ctx.attrs?.status },
      { label: "issued", value: ctx.attrs?.issuedOn },
      { label: "expires", value: ctx.attrs?.expiresOn },
      {
        label: "serial",
        value: ctx.attrs?.serialNumber,
        mono: true,
        copy: true,
      },
      { label: "issuing CA", value: ctx.attrs?.certificateAuthorityName },
    ],
  },
);

export const ui = () => Layer.mergeAll(ClientCertificateUI);
