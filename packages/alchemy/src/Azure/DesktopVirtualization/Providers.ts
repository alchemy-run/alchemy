import * as Layer from "effect/Layer";
import {
  AppAttachPackage,
  AppAttachPackageProvider,
} from "./AppAttachPackage.ts";
import { Application, ApplicationProvider } from "./Application.ts";
import {
  ApplicationGroup,
  ApplicationGroupProvider,
} from "./ApplicationGroup.ts";
import { HostPool, HostPoolProvider } from "./HostPool.ts";
import { ScalingPlan, ScalingPlanProvider } from "./ScalingPlan.ts";
import {
  ScalingPlanPersonalSchedule,
  ScalingPlanPersonalScheduleProvider,
} from "./ScalingPlanPersonalSchedule.ts";
import {
  ScalingPlanPooledSchedule,
  ScalingPlanPooledScheduleProvider,
} from "./ScalingPlanPooledSchedule.ts";
import { Workspace, WorkspaceProvider } from "./Workspace.ts";

export const resources = [
  AppAttachPackage,
  Application,
  ApplicationGroup,
  HostPool,
  ScalingPlan,
  ScalingPlanPersonalSchedule,
  ScalingPlanPooledSchedule,
  Workspace,
];
export const layers = () =>
  Layer.mergeAll(
    AppAttachPackageProvider(),
    ApplicationProvider(),
    ApplicationGroupProvider(),
    HostPoolProvider(),
    ScalingPlanProvider(),
    ScalingPlanPersonalScheduleProvider(),
    ScalingPlanPooledScheduleProvider(),
    WorkspaceProvider(),
  );
