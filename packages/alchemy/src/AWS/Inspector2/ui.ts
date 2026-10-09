import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { CisScanConfiguration } from "./CisScanConfiguration.ts";
import type { Enabler } from "./Enabler.ts";
import type { Filter } from "./Filter.ts";

/**
 * Dashboard UI providers for AWS Inspector2 resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Security, Identity & Compliance (Inspector) brand red. */
const COLOR = "#DD344C";

export const CisScanConfigurationUI = UIProvider.succeed<CisScanConfiguration>(
  "AWS.Inspector2.CisScanConfiguration",
  {
    displayName: "Inspector CIS Scan Configuration",
    icon: "scale",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.scanName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.scanName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.scanConfigurationArn,
        mono: true,
        copy: true,
      },
      { label: "security level", value: ctx.attrs?.securityLevel },
      { label: "owner", value: ctx.attrs?.ownerId, mono: true },
    ],
  },
);

export const EnablerUI = UIProvider.succeed<Enabler>("AWS.Inspector2.Enabler", {
  displayName: "Inspector Enabler",
  icon: "settings",
  color: COLOR,
  category: "security",
  summary: (ctx) => ctx.attrs?.accountId,
  facts: (ctx) => [
    { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
    { label: "state", value: ctx.attrs?.state },
    {
      label: "resource types",
      value: ctx.attrs?.resourceTypes?.length
        ? ctx.attrs.resourceTypes.join(", ")
        : undefined,
    },
  ],
});

export const FilterUI = UIProvider.succeed<Filter>("AWS.Inspector2.Filter", {
  displayName: "Inspector Filter",
  icon: "filter",
  color: COLOR,
  category: "security",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
    { label: "owner", value: ctx.attrs?.ownerId, mono: true },
    { label: "action", value: ctx.attrs?.action },
    { label: "reason", value: ctx.attrs?.reason },
  ],
});

export const ui = () =>
  Layer.mergeAll(CisScanConfigurationUI, EnablerUI, FilterUI);
