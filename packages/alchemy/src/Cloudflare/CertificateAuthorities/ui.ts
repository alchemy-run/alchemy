import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { HostnameAssociation } from "./HostnameAssociation.ts";

/**
 * Dashboard UI providers for Cloudflare Certificate Authorities resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const HostnameAssociationUI = UIProvider.succeed<HostnameAssociation>(
  "Cloudflare.CertificateAuthorities.HostnameAssociation",
  {
    displayName: "CA Hostname Association",
    icon: "link-2",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.hostnames?.join(", "),
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      {
        label: "mTLS certificate",
        value: ctx.attrs?.mtlsCertificateId ?? "Cloudflare Managed CA",
        mono: ctx.attrs?.mtlsCertificateId !== undefined,
        copy: ctx.attrs?.mtlsCertificateId !== undefined,
      },
      { label: "hostnames", value: ctx.attrs?.hostnames?.join(", ") },
      { label: "hostname count", value: ctx.attrs?.hostnames?.length },
    ],
  },
);

export const ui = () => Layer.mergeAll(HostnameAssociationUI);
