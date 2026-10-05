import * as Layer from "effect/Layer";
import {
  AlertProcessingRule,
  AlertProcessingRuleProvider,
} from "./AlertProcessingRule.ts";
import {
  MetricsContainer,
  MetricsContainerProvider,
} from "./MetricsContainer.ts";
import { PipelineGroup, PipelineGroupProvider } from "./PipelineGroup.ts";
import {
  PrometheusRuleGroup,
  PrometheusRuleGroupProvider,
} from "./PrometheusRuleGroup.ts";
import {
  ScheduledQueryRule,
  ScheduledQueryRuleProvider,
} from "./ScheduledQueryRule.ts";
import {
  SmartDetectorAlertRule,
  SmartDetectorAlertRuleProvider,
} from "./SmartDetectorAlertRule.ts";
import { Workspace, WorkspaceProvider } from "./Workspace.ts";

export const resources = [
  AlertProcessingRule,
  MetricsContainer,
  PipelineGroup,
  PrometheusRuleGroup,
  ScheduledQueryRule,
  SmartDetectorAlertRule,
  Workspace,
];
export const layers = () =>
  Layer.mergeAll(
    AlertProcessingRuleProvider(),
    MetricsContainerProvider(),
    PipelineGroupProvider(),
    PrometheusRuleGroupProvider(),
    ScheduledQueryRuleProvider(),
    SmartDetectorAlertRuleProvider(),
    WorkspaceProvider(),
  );
