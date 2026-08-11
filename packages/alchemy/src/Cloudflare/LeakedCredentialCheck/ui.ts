import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { LeakedCredentialDetection } from "./Detection.ts";
import type { LeakedCredentialCheck } from "./LeakedCredentialCheck.ts";

/**
 * Dashboard UI providers for Cloudflare Leaked Credential Check resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const LeakedCredentialCheckUI =
  UIProvider.succeed<LeakedCredentialCheck>(
    "Cloudflare.LeakedCredentialCheck.LeakedCredentialCheck",
    {
      displayName: "Leaked Credential Check",
      icon: "key-round",
      color: "#F6821F",
      category: "security",
      summary: (ctx) =>
        ctx.attrs?.enabled === undefined
          ? (ctx.attrs?.zoneId ?? ctx.props?.zoneId)
          : ctx.attrs.enabled
            ? "enabled"
            : "disabled",
      facts: (ctx) => [
        { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
        { label: "enabled", value: ctx.attrs?.enabled },
      ],
    },
  );

export const LeakedCredentialDetectionUI =
  UIProvider.succeed<LeakedCredentialDetection>(
    "Cloudflare.LeakedCredentialCheck.Detection",
    {
      displayName: "Leaked Credential Detection",
      icon: "file-lock-2",
      color: "#F6821F",
      category: "security",
      summary: (ctx) => ctx.attrs?.detectionId ?? ctx.attrs?.zoneId,
      facts: (ctx) => [
        { label: "id", value: ctx.attrs?.detectionId, mono: true, copy: true },
        { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
        { label: "username expr", value: ctx.attrs?.username, mono: true },
        { label: "password expr", value: ctx.attrs?.password, mono: true },
      ],
    },
  );

export const ui = () =>
  Layer.mergeAll(LeakedCredentialCheckUI, LeakedCredentialDetectionUI);
