import type { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  getWorkerExport as getSharedWorkerExport,
  type SharedBuildOptions,
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

export { handleRpcExit, type WorkerBuild } from "../../Workers/Worker.ts";

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
}) => getSharedWorkerExport<Export>(options, buildOptions);

export const makeWorkerBridge = (
  Base: typeof WorkerEntrypoint | typeof DurableObject,
  options: { entrypoint: any; stack: { name: string; stage: string } },
) =>
  makeWorkerdWorkerBridge(Base, {
    ...options,
    buildOptions,
    handlers: ExportedHandlerMethods,
    services: (context, env) =>
      Layer.succeed(WorkerExecutionContext, fromExecutionContext(context, env)),
  });
