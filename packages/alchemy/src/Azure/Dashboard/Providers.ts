import * as Layer from "effect/Layer";
import {
  ManagedDashboard,
  ManagedDashboardProvider,
} from "./ManagedDashboard.ts";

export const resources = [ManagedDashboard];
export const layers = () => Layer.mergeAll(ManagedDashboardProvider());
