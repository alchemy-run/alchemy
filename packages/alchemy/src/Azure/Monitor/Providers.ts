import * as Layer from "effect/Layer";
import {
  MetricsContainer,
  MetricsContainerProvider,
} from "./MetricsContainer.ts";
import { PipelineGroup, PipelineGroupProvider } from "./PipelineGroup.ts";
import {
  ScheduledQueryRule,
  ScheduledQueryRuleProvider,
} from "./ScheduledQueryRule.ts";
import { Workspace, WorkspaceProvider } from "./Workspace.ts";

export const resources = [
  MetricsContainer,
  PipelineGroup,
  ScheduledQueryRule,
  Workspace,
];
export const layers = () =>
  Layer.mergeAll(
    MetricsContainerProvider(),
    PipelineGroupProvider(),
    ScheduledQueryRuleProvider(),
    WorkspaceProvider(),
  );
