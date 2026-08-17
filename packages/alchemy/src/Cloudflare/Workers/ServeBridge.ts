/**
 * The Cloudflare (workerd / Node dev / prerender) recipe of the
 * `alchemy/Serve` runtime bridge — the cloud-specific half of
 * `Serve/Bridge.ts`'s {@link makeBridgeCore}. Stamped on Cloudflare Worker
 * and Website classes under `SERVE_BRIDGE_KEY` at class construction, so
 * it rides the site module's own import graph into whatever bundle
 * contains the site; the neutral `alchemy/Serve` core never imports it.
 *
 * Leaf-import discipline (this module is compiled by foreign bundlers —
 * Next/turbopack, nitro rollup — into workerd server bundles):
 *   - `CloudflareEnvironment.ts` is the leaf service module (the OAuth-
 *     reaching Layer factories live in `CloudflareEnvironmentLayers.ts`)
 *   - `RuntimeEnvironment`, NOT `Worker.ts` (whose provider import graph
 *     reaches the workerd native binary through the local-runtime chain)
 *   - `platform-node` only via dynamic import, evaluated exclusively in
 *     Node worlds (framework dev servers, prerenderers) — a static import
 *     500s every SSR dispatch on workerd ("Failed to load external module
 *     node:process")
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import {
  makeBridgeCore,
  type BridgeRecipe,
  type ServeOptions,
  type SiteFetchOptions,
  type SiteRuntime,
} from "../../Serve/Bridge.ts";
import { SERVE_BRIDGE_KEY } from "../../Serve/constants.ts";
import { resolveServeEnv } from "../../Serve/Env.ts";
import { makeRequestEffect } from "./HttpServer.ts";
import {
  WorkerEnvironment,
  WorkerExecutionContext,
  deferredExecutionContext,
  fromExecutionContext,
} from "./RuntimeEnvironment.ts";

const recipe: BridgeRecipe = {
  // The Cloudflare env ladder: guarded `cloudflare:workers` env →
  // `getCloudflareContext()`-shaped globals → `process.env`.
  resolveEnv: (explicit) => resolveServeEnv(explicit),

  layers: (env) =>
    Layer.mergeAll(
      Layer.succeed(WorkerEnvironment, env),
      // Init-phase ExecutionContext: yieldable from the site's top-level
      // closure; its RuntimeContext-colored methods defer to the real
      // per-event context provided through `eventLayers`.
      Layer.succeed(WorkerExecutionContext, deferredExecutionContext),
      Layer.succeed(
        CloudflareEnvironment,
        // @ts-expect-error - mirrors WorkerBridge: only this property is
        // needed and available at runtime
        Effect.succeed({
          account: env.ALCHEMY_CLOUDFLARE_ACCOUNT_ID,
        }),
      ),
    ),

  platform: async () => {
    const base = Layer.mergeAll(
      FetchHttpClient.layer,
      Logger.layer([Logger.consolePretty()]),
    );
    // Platform by world: on workerd the Node platform stays OUT of the
    // graph entirely; the dynamic import below only evaluates in Node
    // worlds, where platform-node genuinely exists.
    return typeof navigator !== "undefined" &&
      navigator.userAgent === "Cloudflare-Workers"
      ? base
      : Layer.mergeAll(
          (await import("@effect/platform-node/NodeServices")).layer,
          base,
        );
  },

  requestEffect: (request, handler) =>
    makeRequestEffect(request as any, handler),

  eventLayers: (options: SiteFetchOptions): Layer.Layer<any, any, any> =>
    options.executionContext !== undefined
      ? Layer.succeed(
          WorkerExecutionContext,
          fromExecutionContext(options.executionContext as any),
        )
      : options.waitUntil !== undefined
        ? Layer.succeed(
            WorkerExecutionContext,
            // Synthesize a minimal ExecutionContext from the adapter's
            // waitUntil so `ctx.waitUntil`-colored user code works on
            // entries that never see the real workerd context.
            fromExecutionContext({
              waitUntil: (promise: Promise<unknown>) =>
                options.waitUntil!(promise),
              passThroughOnException: () => {},
            } as any),
          )
        : (Layer.empty as unknown as Layer.Layer<any, any, any>),
};

const core = makeBridgeCore(recipe);

/** The core, for the workerd wrapper entry (`ServeWorkerEntry.ts`). */
export const workerServeCore = core;

/**
 * The class-carried serve bridge for Cloudflare-hosted Worker/Website
 * classes — the `ServeBridge`-shaped object `Serve.make` (and the
 * framework mounts built on it) dispatches matched requests to, and whose
 * `runtime` seam hands the value-form `createClient` the same memoized
 * instance runtime as the fetch path.
 */
export const workerServeBridge = {
  match: (
    site: object,
    request: Request,
    options?: ServeOptions,
  ): Promise<Response | undefined> => core.match(site, request, options),
  dispose: (site: object): Promise<void> => core.dispose(site),
  runtime: (site: object, env: Record<string, unknown>): Promise<SiteRuntime> =>
    core.getRuntime(site, env),
};

/**
 * Attach the Cloudflare serve bridge to a Worker/Website class so
 * `Serve.make(Site)` — and the framework mounts built on it — dispatches
 * through the workerd layer recipe. Mirrors the AWS constructs'
 * `attachLambdaServeBridge`; called by the Cloudflare class factories.
 * @internal
 */
export const attachWorkerServeBridge = <T>(cls: T): T =>
  Object.assign(cls as object, {
    [SERVE_BRIDGE_KEY]: workerServeBridge,
  }) as T;
