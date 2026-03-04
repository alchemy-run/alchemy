import * as ServiceMap from "effect/ServiceMap";
import type { ProcessExecutionContext } from "../Host.ts";

export class ProcessRuntime extends ServiceMap.Service<
  ProcessRuntime,
  ProcessRuntimeService
>()("ProcessRuntime") {}

export interface ProcessRuntimeService extends ProcessExecutionContext {}
