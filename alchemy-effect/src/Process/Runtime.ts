import * as ServiceMap from "effect/ServiceMap";
import type { DaemonExecutionContext } from "../Executable.ts";

export class ProcessRuntime extends ServiceMap.Service<
  ProcessRuntime,
  ProcessRuntimeService
>()("ProcessRuntime") {}

export interface ProcessRuntimeService extends DaemonExecutionContext {}
