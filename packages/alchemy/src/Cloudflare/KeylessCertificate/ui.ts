import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { KeylessCertificate } from "./KeylessCertificate.ts";

/**
 * Dashboard UI providers for Cloudflare Keyless SSL resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const KeylessCertificateUI = UIProvider.succeed<KeylessCertificate>(
  "Cloudflare.KeylessCertificate.KeylessCertificate",
  {
    displayName: "Keyless Certificate",
    icon: "key-round",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.keylessCertificateId,
    facts: (ctx) => [
      {
        label: "keyless id",
        value: ctx.attrs?.keylessCertificateId,
        mono: true,
        copy: true,
      },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name },
      {
        label: "key server",
        value:
          ctx.attrs?.host === undefined
            ? undefined
            : `${ctx.attrs.host}:${ctx.attrs.port ?? 24008}`,
        mono: true,
      },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "status", value: ctx.attrs?.status },
      { label: "modified", value: ctx.attrs?.modifiedOn },
    ],
  },
);

export const ui = () => Layer.mergeAll(KeylessCertificateUI);
