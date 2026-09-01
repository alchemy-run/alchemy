import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Discovery } from "./Discovery.ts";
import type { GroupingConfiguration } from "./GroupingConfiguration.ts";
import type { InstrumentationConfiguration } from "./InstrumentationConfiguration.ts";
import type { ServiceLevelObjective } from "./ServiceLevelObjective.ts";

/**
 * Dashboard UI providers for AWS ApplicationSignals resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const APPLICATION_SIGNALS_COLOR = "#E7157B";

export const DiscoveryUI = UIProvider.succeed<Discovery>(
  "AWS.ApplicationSignals.Discovery",
  {
    displayName: "Application Signals Discovery",
    icon: "search",
    color: APPLICATION_SIGNALS_COLOR,
    category: "observability",
    summary: (ctx) => ctx.attrs?.accountId,
    facts: (ctx) => [
      { label: "account", value: ctx.attrs?.accountId, mono: true },
      { label: "region", value: ctx.attrs?.region },
    ],
  },
);

export const GroupingConfigurationUI =
  UIProvider.succeed<GroupingConfiguration>(
    "AWS.ApplicationSignals.GroupingConfiguration",
    {
      displayName: "Application Signals Grouping Configuration",
      icon: "layers",
      color: APPLICATION_SIGNALS_COLOR,
      category: "observability",
      summary: (ctx) =>
        ctx.attrs?.groupingAttributeDefinitions?.length === undefined
          ? undefined
          : `${ctx.attrs.groupingAttributeDefinitions.length} grouping(s)`,
      facts: (ctx) => [
        {
          label: "groupings",
          value: ctx.attrs?.groupingAttributeDefinitions?.length,
        },
        {
          label: "names",
          value: ctx.attrs?.groupingAttributeDefinitions
            ?.map((d) => d.GroupingName)
            .join(", "),
        },
        { label: "updated", value: ctx.attrs?.updatedAt },
      ],
    },
  );

export const InstrumentationConfigurationUI =
  UIProvider.succeed<InstrumentationConfiguration>(
    "AWS.ApplicationSignals.InstrumentationConfiguration",
    {
      displayName: "Application Signals Instrumentation Configuration",
      icon: "activity",
      color: APPLICATION_SIGNALS_COLOR,
      category: "observability",
      summary: (ctx) => ctx.attrs?.service,
      facts: (ctx) => [
        { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
        { label: "type", value: ctx.attrs?.instrumentationType },
        { label: "service", value: ctx.attrs?.service, copy: true },
        { label: "environment", value: ctx.attrs?.environment },
        { label: "signal", value: ctx.attrs?.signalType },
        { label: "created", value: ctx.attrs?.createdAt },
      ],
    },
  );

export const ServiceLevelObjectiveUI =
  UIProvider.succeed<ServiceLevelObjective>(
    "AWS.ApplicationSignals.ServiceLevelObjective",
    {
      displayName: "Application Signals SLO",
      icon: "gauge",
      color: APPLICATION_SIGNALS_COLOR,
      category: "observability",
      summary: (ctx) => ctx.attrs?.sloName,
      facts: (ctx) => [
        { label: "slo", value: ctx.attrs?.sloName, copy: true },
        { label: "arn", value: ctx.attrs?.sloArn, mono: true, copy: true },
        { label: "evaluation", value: ctx.attrs?.evaluationType },
        { label: "description", value: ctx.props?.description },
      ],
    },
  );

export const ui = () =>
  Layer.mergeAll(
    DiscoveryUI,
    GroupingConfigurationUI,
    InstrumentationConfigurationUI,
    ServiceLevelObjectiveUI,
  );
