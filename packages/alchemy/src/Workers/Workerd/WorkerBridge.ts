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
import cloudflare_workers from "../../Cloudflare/Workers/cloudflare_workers.ts";
import {
  getWorkerExport,
  handleRpcExit,
  type SharedBuildOptions,
  type WorkerBuild,
} from "../Worker.ts";
import { dispatchRpcMethod, processEvent } from "../WorkerBridge.ts";

// NodeTerminal registers stdin listeners at construction; workerd has no stdin.
const terminal = Layer.succeed(
  Terminal.Terminal,
  Terminal.make({
    columns: Effect.succeed(0),
    rows: Effect.succeed(0),
    readInput: Effect.die(
      new Error("Terminal input is unavailable in workerd"),
    ),
    readLine: Effect.die(new Error("Terminal input is unavailable in workerd")),
    display: (text) => Effect.sync(() => console.log(text)),
  }),
);

export const workerdBuildOptions: SharedBuildOptions = {
  platform: Layer.mergeAll(
    Layer.provideMerge(
      NodeChildProcessSpawner.layer,
      Layer.mergeAll(
        NodeFileSystem.layer,
        NodeCrypto.layer,
        NodePath.layer,
        NodeStdio.layer,
        terminal,
      ),
    ),
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  ),
  env: cloudflare_workers.pipe(
    Effect.map(({ env }) => env as Record<string, unknown>),
  ),
};

export interface WorkerdWorkerBridgeOptions {
  readonly entrypoint: any;
  readonly stack: { readonly name: string; readonly stage: string };
  readonly buildOptions: SharedBuildOptions;
  readonly handlers: readonly string[];
  readonly services: (
    context: cf.ExecutionContext,
    env: Record<string, unknown>,
  ) => Layer.Layer<never>;
}

export const makeWorkerBridge = (
  Base: typeof WorkerEntrypoint | typeof DurableObject,
  options: WorkerdWorkerBridgeOptions,
) => {
  const { build } = getWorkerExport(
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
          built: WorkerBuild,
        ) => readonly [Effect.Effect<any, any, any>, Context.Context<never>],
        onExit: (exit: Parameters<typeof handleRpcExit>[0]) => Promise<T>,
      ) =>
        processEvent(build, {
          makeEffect,
          services: options.services(this.ctx, this.env),
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
          if (typeof prop !== "string" || prop in target)
            return (target as any)[prop];
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

  // Native script validation inspects prototype methods before instantiation.
  for (const method of options.handlers) {
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
