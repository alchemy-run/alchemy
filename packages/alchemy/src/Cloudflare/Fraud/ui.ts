import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { DetectionSettings } from "./DetectionSettings.ts";

/**
 * Dashboard UI providers for Cloudflare Fraud Detection resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const DetectionSettingsUI = UIProvider.succeed<DetectionSettings>(
  "Cloudflare.Fraud.DetectionSettings",
  {
    displayName: "Fraud Detection Settings",
    icon: "shield-check",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.zoneId,
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "user profiles", value: ctx.attrs?.userProfiles },
      {
        label: "username expressions",
        value: ctx.attrs?.usernameExpressions?.length
          ? ctx.attrs.usernameExpressions.join(", ")
          : undefined,
        mono: true,
      },
      {
        label: "auth settings",
        value:
          ctx.attrs?.authenticationSettings === undefined
            ? undefined
            : "configured",
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(DetectionSettingsUI);
