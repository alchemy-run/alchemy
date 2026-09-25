import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { LicenseConfiguration } from "./LicenseConfiguration.ts";

/**
 * Dashboard UI providers for AWS License Manager resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const LicenseConfigurationUI = UIProvider.succeed<LicenseConfiguration>(
  "AWS.LicenseManager.LicenseConfiguration",
  {
    displayName: "License Manager Configuration",
    icon: "scroll-text",
    color: "#E7157B",
    category: "config",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "configuration", value: ctx.attrs?.name, copy: true },
      {
        label: "id",
        value: ctx.attrs?.licenseConfigurationId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.licenseConfigurationArn,
        mono: true,
        copy: true,
      },
      { label: "counting type", value: ctx.attrs?.licenseCountingType },
    ],
  },
);

export const ui = () => Layer.mergeAll(LicenseConfigurationUI);
