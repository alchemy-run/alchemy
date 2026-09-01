import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { EnabledBaseline } from "./EnabledBaseline.ts";
import type { EnabledControl } from "./EnabledControl.ts";
import type { LandingZone } from "./LandingZone.ts";

/**
 * Dashboard UI providers for AWS Control Tower resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Management & Governance brand pink. */
const COLOR = "#E7157B";

export const EnabledBaselineUI = UIProvider.succeed<EnabledBaseline>(
  "AWS.ControlTower.EnabledBaseline",
  {
    displayName: "Control Tower Enabled Baseline",
    icon: "shield-check",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.baselineIdentifier,
    facts: (ctx) => [
      {
        label: "arn",
        value: ctx.attrs?.enabledBaselineArn,
        mono: true,
        copy: true,
      },
      {
        label: "baseline",
        value: ctx.attrs?.baselineIdentifier,
        mono: true,
        copy: true,
      },
      { label: "target", value: ctx.attrs?.targetIdentifier, mono: true },
      { label: "version", value: ctx.attrs?.baselineVersion },
    ],
  },
);

export const EnabledControlUI = UIProvider.succeed<EnabledControl>(
  "AWS.ControlTower.EnabledControl",
  {
    displayName: "Control Tower Enabled Control",
    icon: "shield",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.controlIdentifier,
    facts: (ctx) => [
      {
        label: "arn",
        value: ctx.attrs?.enabledControlArn,
        mono: true,
        copy: true,
      },
      {
        label: "control",
        value: ctx.attrs?.controlIdentifier,
        mono: true,
        copy: true,
      },
      { label: "target", value: ctx.attrs?.targetIdentifier, mono: true },
    ],
  },
);

export const LandingZoneUI = UIProvider.succeed<LandingZone>(
  "AWS.ControlTower.LandingZone",
  {
    displayName: "Control Tower Landing Zone",
    icon: "map",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.version,
    facts: (ctx) => [
      {
        label: "arn",
        value: ctx.attrs?.landingZoneArn,
        mono: true,
        copy: true,
      },
      { label: "version", value: ctx.attrs?.version },
      { label: "status", value: ctx.attrs?.status },
      { label: "latest version", value: ctx.attrs?.latestAvailableVersion },
      { label: "drift", value: ctx.attrs?.driftStatus },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(EnabledBaselineUI, EnabledControlUI, LandingZoneUI);
