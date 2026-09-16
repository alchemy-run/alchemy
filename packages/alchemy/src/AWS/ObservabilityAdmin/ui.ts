import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { TelemetryConfig } from "./TelemetryConfig.ts";
import type { TelemetryRule } from "./TelemetryRule.ts";

/**
 * Dashboard UI providers for AWS ObservabilityAdmin resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Observability (CloudWatch family) brand pink. */
const COLOR = "#E7157B";

export const TelemetryConfigUI = UIProvider.succeed<TelemetryConfig>(
  "AWS.ObservabilityAdmin.TelemetryConfig",
  {
    displayName: "Observability Admin Telemetry Config",
    icon: "gauge",
    color: COLOR,
    category: "observability",
    summary: (ctx) => ctx.attrs?.status,
    facts: (ctx) => [
      { label: "status", value: ctx.attrs?.status },
      { label: "prior status", value: ctx.attrs?.priorStatus },
    ],
  },
);

export const TelemetryRuleUI = UIProvider.succeed<TelemetryRule>(
  "AWS.ObservabilityAdmin.TelemetryRule",
  {
    displayName: "Observability Admin Telemetry Rule",
    icon: "activity",
    color: COLOR,
    category: "observability",
    summary: (ctx) => ctx.attrs?.ruleName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.ruleName, copy: true },
      { label: "arn", value: ctx.attrs?.ruleArn, mono: true, copy: true },
      { label: "telemetry type", value: ctx.attrs?.telemetryType },
      { label: "resource type", value: ctx.attrs?.resourceType },
    ],
  },
);

export const ui = () => Layer.mergeAll(TelemetryConfigUI, TelemetryRuleUI);
