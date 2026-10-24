import * as Layer from "effect/Layer";
import { AppAttachPackage, AppAttachPackageProvider } from "./AppAttachPackage.ts";
import { Application, ApplicationProvider } from "./Application.ts";
import { ApplicationGroup, ApplicationGroupProvider } from "./ApplicationGroup.ts";
import { HostPool, HostPoolProvider } from "./HostPool.ts";
import { MsixPackage, MsixPackageProvider } from "./MsixPackage.ts";
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
  MsixPackage,
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
    MsixPackageProvider(),
    ScalingPlanProvider(),
    ScalingPlanPersonalScheduleProvider(),
    ScalingPlanPooledScheduleProvider(),
    WorkspaceProvider(),
  );
