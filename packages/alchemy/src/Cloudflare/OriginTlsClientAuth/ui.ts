import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Certificate } from "./Certificate.ts";
import type { HostnameAssociation } from "./HostnameAssociation.ts";
import type { HostnameCertificate } from "./HostnameCertificate.ts";
import type { Setting } from "./Setting.ts";

/**
 * Dashboard UI providers for Cloudflare Authenticated Origin Pulls
 * (Origin TLS Client Auth) resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const CertificateUI = UIProvider.succeed<Certificate>(
  "Cloudflare.OriginTlsClientAuth.Certificate",
  {
    displayName: "AOP Certificate",
    icon: "file-key",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.certificateId,
    facts: (ctx) => [
      {
        label: "certificate id",
        value: ctx.attrs?.certificateId,
        mono: true,
        copy: true,
      },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "issuer", value: ctx.attrs?.issuer },
      { label: "expires", value: ctx.attrs?.expiresOn },
      { label: "uploaded", value: ctx.attrs?.uploadedOn },
    ],
  },
);

export const HostnameCertificateUI = UIProvider.succeed<HostnameCertificate>(
  "Cloudflare.OriginTlsClientAuth.HostnameCertificate",
  {
    displayName: "AOP Hostname Certificate",
    icon: "file-key-2",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.certificateId,
    facts: (ctx) => [
      {
        label: "certificate id",
        value: ctx.attrs?.certificateId,
        mono: true,
        copy: true,
      },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "issuer", value: ctx.attrs?.issuer },
      {
        label: "serial",
        value: ctx.attrs?.serialNumber,
        mono: true,
        copy: true,
      },
      { label: "expires", value: ctx.attrs?.expiresOn },
    ],
  },
);

export const HostnameAssociationUI = UIProvider.succeed<HostnameAssociation>(
  "Cloudflare.OriginTlsClientAuth.HostnameAssociation",
  {
    displayName: "AOP Hostname Association",
    icon: "link-2",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.hostname,
    facts: (ctx) => [
      { label: "hostname", value: ctx.attrs?.hostname, copy: true },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      {
        label: "certificate id",
        value: ctx.attrs?.certId,
        mono: true,
        copy: true,
      },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "status", value: ctx.attrs?.status },
      { label: "certificate status", value: ctx.attrs?.certStatus },
    ],
  },
);

export const SettingUI = UIProvider.succeed<Setting>(
  "Cloudflare.OriginTlsClientAuth.Setting",
  {
    displayName: "AOP Zone Setting",
    icon: "settings-2",
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

export const ui = () =>
  Layer.mergeAll(
    CertificateUI,
    HostnameCertificateUI,
    HostnameAssociationUI,
    SettingUI,
  );
