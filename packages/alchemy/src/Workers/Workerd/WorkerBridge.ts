/**
 * The workerd flavor of the Worker bridge, shared by every engine that runs
 * Workers-compatible bundles (Cloudflare today): the platform services a
 * workerd isolate builds its init against, and the `WorkerEntrypoint` class
 * that turns workerd's handler and JSRPC calls into Effect events over the
 * engine-invariant core in `../WorkerBridge.ts`.
 *
 * @internal
 */
import type * as cf from "@cloudflare/workers-types";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeStdio from "@effect/platform-node/NodeStdio";
import * as NodeTerminal from "@effect/platform-node/NodeTerminal";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import {
  getWorkerExport,
  handleRpcExit,
  type SharedBuildOptions,
  type WorkerBuild,
  type WorkerRuntimeContextLike,
} from "../Worker.ts";
import { dispatchRpcMethod, processEvent } from "../WorkerBridge.ts";
import workerdModule from "./Module.ts";

/** workerd's `WorkerEntrypoint` (or `DurableObject`) base class. */
export type WorkerdEntrypointClass = abstract new (ctx: any, env: any) => object;

/** The platform services and environment record of a workerd isolate. */
// `NodeServices.layer`, except `NodeTerminal` is only built when
// `process.stdin` is usable: it calls `process.stdin.once` while it builds,
// and workerd's `process` has no `stdin` on compatibility dates before
// Node.js process v2.
const terminal = Layer.unwrap(
  Effect.sync(() =>
    typeof globalThis.process?.stdin?.once === "function" ? NodeTerminal.layer : Layer.empty,
  ),
);
const platformServices = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer, NodePath.layer, NodeStdio.layer, terminal),
);

export const workerdBuildOptions: SharedBuildOptions = {
  platform: Layer.mergeAll(
    platformServices,
    FetchHttpClient.layer,
    // TODO(sam): wire this up to telemetry more directly
    Logger.layer([Logger.consolePretty()]),
  ),
  env: workerdModule.pipe(Effect.map(({ env }) => env as Record<string, unknown>)),
};

export interface WorkerdWorkerBridgeOptions<Runtime extends WorkerRuntimeContextLike> {
  readonly entrypoint: any;
  readonly stack: { readonly name: string; readonly stage: string };
  readonly buildOptions: SharedBuildOptions;
  /** The workerd handler methods the bridge installs (`fetch`, `queue`, …). */
  readonly handlers: readonly string[];
  /** Per-event services built from workerd's execution context and env. */
  readonly services: (
    context: cf.ExecutionContext,
    env: Record<string, unknown>,
    built: WorkerBuild<any, Runtime>,
  ) => Layer.Layer<never>;
}

/**
 * Makes the WorkerEntrypoint class and bridges to Effect handler and RPC
 * calls.
 */
export const makeWorkerBridge = <Runtime extends WorkerRuntimeContextLike>(
  Base: WorkerdEntrypointClass,
  options: WorkerdWorkerBridgeOptions<Runtime>,
) => {
  const { build } = getWorkerExport<any, Runtime>(
    {
      entrypoint: options.entrypoint,
      stack: options.stack,
      exportName: "default",
    },
    options.buildOptions,
  );

  class WorkerBridge extends Base {
    constructor(
      public readonly ctx: any,
      public readonly env: any,
    ) {
      super(ctx, env);
      const event = <T>(
        makeEffect: (
          built: WorkerBuild<any, Runtime>,
        ) => readonly [Effect.Effect<any, any, any>, Context.Context<never>],
        onExit: (
          exit: Parameters<typeof handleRpcExit>[0],
          scope: Parameters<typeof handleRpcExit>[1] & {},
        ) => Promise<T>,
      ) =>
        processEvent(build, {
          makeEffect,
          services: (built) => options.services(this.ctx, this.env, built),
          waitUntil: (promise) => this.ctx.waitUntil(promise),
          onExit,
        });

      for (const method of options.handlers) {
        (this as any)[method] = (input: any) =>
          event(
            (built) => built.export[method](input, this.env, this.ctx),
            (exit) =>
              exit._tag === "Success"
                ? Promise.resolve(exit.value)
                : Promise.reject(Cause.squash(exit.cause)),
          );
      }

      return new Proxy(this, {
        get: (target, prop) => {
          if (typeof prop !== "string" || prop in target) return (target as any)[prop];
          return (...args: unknown[]) =>
            event(
              (built) => [dispatchRpcMethod(built.shape(), prop, args), Context.empty()] as const,
              handleRpcExit,
            );
        },
      });
    }
  }

  // Stub prototype methods so native script validation detects the
  // standard handler set; per-instance overrides above are what actually
  // run.
  for (const method of options.handlers) {
    Object.defineProperty(WorkerBridge.prototype, method, {
      value: function () {
        throw new Error(`Bridge method '${method}' was called before instance setup`);
      },
      writable: true,
      configurable: true,
    });
  }
  return WorkerBridge;
};
