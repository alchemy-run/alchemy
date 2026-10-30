import {
  makeWorkerRuntimeContext as makeWorkerdRuntimeContext,
  type WorkerRuntimeContext,
} from "alchemy/Workers/Workerd/WorkerRuntimeContext";
import type { WorkflowExport } from "../Workflows/Workflow.ts";
import type { DurableObjectExport } from "./DurableObject.ts";
import type { SqlMigrationsExport } from "./SqlMigrationsRuntime.ts";
import { WebhookHostLive } from "./WebhookHost.ts";
import { WorkerTypeId } from "./WorkerRuntime.ts";

export type { WorkerRuntimeContext } from "alchemy/Workers/Workerd/WorkerRuntimeContext";

export type WorkerExport = DurableObjectExport | WorkflowExport | SqlMigrationsExport;

export const makeWorkerRuntimeContext = (id: string): WorkerRuntimeContext =>
  makeWorkerdRuntimeContext(id, {
    type: WorkerTypeId,
    // Every Worker can receive webhooks, so event sources need no host wiring.
    hostServices: WebhookHostLive,
  });
