import * as Layer from "effect/Layer";
import { RetentionPolicy, RetentionPolicyProvider } from "./RetentionPolicy.ts";
import { Scheduler, SchedulerProvider } from "./Scheduler.ts";
import { TaskHub, TaskHubProvider } from "./TaskHub.ts";

export const resources = [RetentionPolicy, Scheduler, TaskHub];
export const layers = () =>
  Layer.mergeAll(
    RetentionPolicyProvider(),
    SchedulerProvider(),
    TaskHubProvider(),
  );
