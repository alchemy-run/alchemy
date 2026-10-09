import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Detector } from "./Detector.ts";
import type { Filter } from "./Filter.ts";
import type { IPSet } from "./IPSet.ts";
import type { ThreatIntelSet } from "./ThreatIntelSet.ts";

/**
 * Dashboard UI providers for AWS GuardDuty resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Security, Identity & Compliance (GuardDuty) brand red. */
const COLOR = "#DD344C";

export const DetectorUI = UIProvider.succeed<Detector>(
  "AWS.GuardDuty.Detector",
  {
    displayName: "GuardDuty Detector",
    icon: "shield",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.detectorId,
    facts: (ctx) => [
      { label: "id", value: ctx.attrs?.detectorId, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.detectorArn, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "publishing frequency",
        value: ctx.attrs?.findingPublishingFrequency,
      },
    ],
  },
);

export const FilterUI = UIProvider.succeed<Filter>("AWS.GuardDuty.Filter", {
  displayName: "GuardDuty Filter",
  icon: "filter",
  color: COLOR,
  category: "security",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "arn", value: ctx.attrs?.filterArn, mono: true, copy: true },
    { label: "detector", value: ctx.attrs?.detectorId, mono: true },
    { label: "action", value: ctx.attrs?.action },
    { label: "rank", value: ctx.attrs?.rank },
  ],
});

export const IPSetUI = UIProvider.succeed<IPSet>("AWS.GuardDuty.IPSet", {
  displayName: "GuardDuty Trusted IP Set",
  icon: "shield-check",
  color: COLOR,
  category: "security",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.ipSetId, mono: true, copy: true },
    { label: "detector", value: ctx.attrs?.detectorId, mono: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "format", value: ctx.attrs?.format },
    { label: "location", value: ctx.attrs?.location, mono: true, copy: true },
  ],
});

export const ThreatIntelSetUI = UIProvider.succeed<ThreatIntelSet>(
  "AWS.GuardDuty.ThreatIntelSet",
  {
    displayName: "GuardDuty Threat Intel Set",
    icon: "alert-triangle",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "id",
        value: ctx.attrs?.threatIntelSetId,
        mono: true,
        copy: true,
      },
      { label: "detector", value: ctx.attrs?.detectorId, mono: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "format", value: ctx.attrs?.format },
      { label: "location", value: ctx.attrs?.location, mono: true, copy: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(DetectorUI, FilterUI, IPSetUI, ThreatIntelSetUI);
