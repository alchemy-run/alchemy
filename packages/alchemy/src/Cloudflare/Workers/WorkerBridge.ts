import type * as cf from "@cloudflare/workers-types";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeStdio from "@effect/platform-node/NodeStdio";
import type { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Terminal from "effect/Terminal";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  getWorkerExport as getSharedWorkerExport,
  handleRpcExit,
  type SharedBuildOptions,
  type WorkerBuild,
} from "../../Workers/Worker.ts";
import { dispatchRpcMethod, processEvent } from "../../Workers/WorkerBridge.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import cloudflare_workers from "./cloudflare_workers.ts";
import {
  ExportedHandlerMethods,
  WorkerExecutionContext,
  deferredExecutionContext,
  fromExecutionContext,
} from "./Worker.ts";

export { handleRpcExit, type WorkerBuild } from "../../Workers/Worker.ts";

// `NodeServices.layer` minus `NodeTerminal`: as of effect beta.105 the
// Node terminal registers `process.stdin` listeners AT LAYER BUILD
// (`stdin.once("end", ...)`), and workerd's `process.stdin` stub has no
// listener API — building it kills every effect-native worker with error
// 1101 before the first request. An isolate has no terminal anyway; the
// stub keeps the service constructible and fails on USE with a message
// instead of at boot.
const stubTerminal = Layer.succeed(
  Terminal.Terminal,
  Terminal.make({
    columns: Effect.succeed(0),
    rows: Effect.succeed(0),
    readInput: Effect.die(
      new Error("Terminal input is unavailable inside a Cloudflare Worker"),
    ),
    readLine: Effect.die(
      new Error("Terminal input is unavailable inside a Cloudflare Worker"),
    ),
    display: (text) => Effect.sync(() => console.log(text)),
  }),
);

/** The workerd half of the shared build: platform services, `env`, and the Cloudflare services. */
const workerdBuildOptions: SharedBuildOptions = {
  platform: Layer.mergeAll(
    Layer.provideMerge(
      NodeChildProcessSpawner.layer,
      Layer.mergeAll(
        NodeFileSystem.layer,
        NodeCrypto.layer,
        NodePath.layer,
        NodeStdio.layer,
        stubTerminal,
      ),
    ),
    FetchHttpClient.layer,
    // TODO(sam): wire this up to telemetry more directly
    Logger.layer([Logger.consolePretty()]),
  ),
  env: cloudflare_workers.pipe(
    Effect.map(({ env }) => env as Record<string, unknown>),
  ),
  extra: (env) =>
    Layer.mergeAll(
      // Init-phase ExecutionContext: yieldable from the Worker's top-level
      // closure (and Layers); its RuntimeContext-colored methods defer to
      // the real per-event context provided by `processEvent`.
      Layer.succeed(WorkerExecutionContext, deferredExecutionContext),
      Layer.succeed(
        CloudflareEnvironment,
        // TODO(sam): fix this with maybe a CloudflareAccountId Effect service
        // @ts-expect-error - this is hacky, but we only need and have this property
        Effect.succeed({
          account: env.ALCHEMY_CLOUDFLARE_ACCOUNT_ID,
        }),
      ),
    ),
};

/**
 * Resolve one named export of the entrypoint against the isolate's shared
 * build, with the workerd platform services and `env` provided.
 */
export const getWorkerExport = <Export = any>(options: {
  entrypoint: any;
  stack: { name: string; stage: string };
  exportName: string;
}) => getSharedWorkerExport<Export>(options, workerdBuildOptions);

/**
 * Makes the WorkerEntrypoint class and bridges to Effect fetch and RPC calls.
 */
export const makeWorkerBridge = (
  Base: typeof WorkerEntrypoint | typeof DurableObject,
  {
    stack,
    entrypoint,
  }: {
    stack: {
      name: string;
      stage: string;
    };
    entrypoint: any;
  },
) => {
  const { build } = getWorkerExport({
    entrypoint,
    stack,
    exportName: "default",
  });

  class WorkerBridge extends Base {
    constructor(
      public readonly ctx: any,
      public readonly env: any,
    ) {
      super(ctx, env);

      const event = <T>(
        makeEffect: (
          built: WorkerBuild,
        ) => readonly [Effect.Effect<any, any, any>, Context.Context<never>],
        onExit: (exit: Parameters<typeof handleRpcExit>[0]) => Promise<T>,
      ) =>
        processEvent(build, {
          makeEffect,
          // The real per-event ExecutionContext shadows the deferred one the
          // isolate context carries.
          services: Layer.succeed(
            WorkerExecutionContext,
            fromExecutionContext(this.ctx as cf.ExecutionContext, this.env),
          ),
          waitUntil: (promise) => this.ctx.waitUntil(promise),
          onExit,
        });

      for (const methodName of ExportedHandlerMethods) {
        (this as any)[methodName] = async (input: any) =>
          event(
            (built) =>
              built.export[methodName](input, this.env, this.ctx) as [
                Effect.Effect<any>,
                Context.Context<never>,
              ],
            (exit) =>
              exit._tag === "Success"
                ? Promise.resolve(exit.value)
                : Promise.reject(Cause.squash(exit.cause)),
          );
      }

      return new Proxy(this, {
        get: (target, prop) => {
          if (typeof prop !== "string") return (target as any)[prop];
          if (prop in target) return (target as any)[prop];
          return (...args: unknown[]) =>
            event(
              (built) =>
                [
                  dispatchRpcMethod(built.shape(), prop, args),
                  Context.empty(),
                ] as const,
              handleRpcExit,
            );
        },
      });
    }
  }

  // Stub prototype methods so Cloudflare's script-validate detects the
  // standard handler set; per-instance overrides above are what actually
  // run.
  for (const method of ExportedHandlerMethods) {
    Object.defineProperty(WorkerBridge.prototype, method, {
      value: function () {
        throw new Error(
          `Bridge method '${method}' was called before instance setup`,
        );
      },
      writable: true,
      configurable: true,
    });
  }

  return WorkerBridge;
};
