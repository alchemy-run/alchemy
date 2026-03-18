import * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";
import type { BaseExecutionContext } from "../ExecutionContext.ts";

export interface ServerExecutionContext extends BaseExecutionContext {
  run: <Req = never, RunReq = never>(
    effect: Effect.Effect<void, never, RunReq>,
  ) => Effect.Effect<void, never, Req | RunReq>;
}

export class ServerContext extends ServiceMap.Service<
  ServerContext,
  ServerExecutionContext
>()("Alchemy::ServerExecutionContext") {}
