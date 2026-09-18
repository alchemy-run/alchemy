import type { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RuntimeContext } from "../../RuntimeContext.ts";
import { Self } from "../../Self.ts";
import {
  getWorkerExport as getSharedWorkerExport,
  type Pin,
  type SharedBuildOptions,
  type WorkerBuild as SharedWorkerBuild,
} from "../../Workers/Worker.ts";
import {
  makeWorkerBridge as makeWorkerdWorkerBridge,
  workerdBuildOptions,
} from "../../Workers/Workerd/WorkerBridge.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironmentService.ts";
import {
  ExportedHandlerMethods,
  WorkerExecutionContext,
  deferredExecutionContext,
  fromExecutionContext,
} from "./WorkerRuntime.ts";

import type { WorkerRuntimeContext } from "./WorkerRuntimeContext.ts";

export { handleRpcExit } from "../../Workers/Worker.ts";

export interface WorkerBuild<Export = any> extends SharedWorkerBuild<Export> {
  readonly runtimeContext: WorkerRuntimeContext;
}

const selfTag = Self as unknown as Context.Service<
  never,
  { readonly RuntimeContext: WorkerRuntimeContext }
>;

const buildOptions: SharedBuildOptions = {
  ...workerdBuildOptions,
  extra: (env) =>
    Layer.mergeAll(
      Layer.succeed(WorkerExecutionContext, deferredExecutionContext),
      Layer.succeed(
        CloudflareEnvironment,
        // Only the deployed account is available inside the isolate.
        // @ts-expect-error The runtime has no provisioning credentials.
        Effect.succeed({ account: env.ALCHEMY_CLOUDFLARE_ACCOUNT_ID }),
      ),
    ),
};

export const getWorkerExport = <Export = any>(options: {
  entrypoint: any;
  stack: { name: string; stage: string };
  exportName: string;
}) => {
  const { build } = getSharedWorkerExport<Export>(options, buildOptions);
  return {
    build: (pin: Pin): Promise<WorkerBuild<Export>> =>
      build(pin).then((built) => ({
        ...built,
        runtimeContext: Context.get(built.context, selfTag).RuntimeContext,
      })),
  };
};

export const makeWorkerBridge = (
  Base: typeof WorkerEntrypoint | typeof DurableObject,
  options: { entrypoint: any; stack: { name: string; stage: string } },
) =>
  makeWorkerdWorkerBridge(Base, {
    ...options,
    buildOptions,
    handlers: ExportedHandlerMethods,
    services: (context, env) =>
      Layer.mergeAll(
        Layer.succeed(
          WorkerExecutionContext,
          fromExecutionContext(context, env),
        ),
        Layer.effect(
          RuntimeContext,
          selfTag.pipe(Effect.map((worker) => worker.RuntimeContext)),
        ),
      ),
  });
