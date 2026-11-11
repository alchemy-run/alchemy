import { RuntimeContext } from "alchemy/RuntimeContext";
import {
  getWorkerExport as getSharedWorkerExport,
  type Pin,
  type SharedBuildOptions,
  type WorkerBuild as SharedWorkerBuild,
} from "alchemy/Workers/Worker";
import {
  makeWorkerBridge as makeWorkerdWorkerBridge,
  workerdBuildOptions,
} from "alchemy/Workers/Workerd/WorkerBridge";
import type { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CloudflareEnvironment } from "../CloudflareEnvironmentService.ts";
import {
  ExportedHandlerMethods,
  WorkerExecutionContext,
  fromExecutionContext,
} from "./WorkerRuntime.ts";
import type { WorkerRuntimeContext } from "./WorkerRuntimeContext.ts";

export { handleRpcExit } from "alchemy/Workers/Worker";

/**
 * The isolate-lifetime artifacts produced by a single layer build: the built
 * service Context, the resolved export for this entrypoint, the user's
 * RPC shape (a thunk — the shape is only populated once `serve` has run),
 * and the telemetry Layer override registered during init (a thunk for the
 * same reason).
 */
export type WorkerBuild<Export = any> = SharedWorkerBuild<Export, WorkerRuntimeContext>;

const buildOptions: SharedBuildOptions = {
  ...workerdBuildOptions,
  extra: (env) =>
    Layer.succeed(
      CloudflareEnvironment,
      // TODO(sam): fix this with maybe a CloudflareAccountId Effect service
      // @ts-expect-error - this is hacky, but we only need and have this property
      Effect.succeed({ account: (env as any).ALCHEMY_CLOUDFLARE_ACCOUNT_ID }),
    ),
};

/**
 * Makes the WorkerEntrypoint class and bridges to Effect fetch and RPC calls.
 */
export const makeWorkerBridge = (
  Base: typeof WorkerEntrypoint | typeof DurableObject,
  { stack, entrypoint }: { stack: { name: string; stage: string }; entrypoint: any },
) =>
  makeWorkerdWorkerBridge<WorkerRuntimeContext>(Base, {
    entrypoint,
    stack,
    buildOptions,
    handlers: ExportedHandlerMethods,
    services: (ctx, env, built) =>
      Layer.mergeAll(
        Layer.succeed(WorkerExecutionContext, fromExecutionContext(ctx as any, env)),
        Layer.succeed(RuntimeContext, built.runtimeContext),
      ),
  });

export const getWorkerExport = <Export = any>(options: {
  entrypoint: any;
  stack: { name: string; stage: string };
  exportName: string;
}): { build: (pin: Pin) => Promise<WorkerBuild<Export>> } =>
  getSharedWorkerExport<Export, WorkerRuntimeContext>(options, buildOptions);
