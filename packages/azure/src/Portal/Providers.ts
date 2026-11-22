import * as Layer from "effect/Layer";
import { Dashboard, DashboardProvider } from "./Dashboard.ts";

export const resources = [Dashboard];
export const layers = () => Layer.mergeAll(DashboardProvider());
