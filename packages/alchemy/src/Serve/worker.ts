/**
 * `alchemy/serve/worker` — the workerd shell the construct-generated
 * wrappers call (DESIGN §6.2a). A generated `virtual:alchemy:website-entry`
 * (or hand-written custom entry) looks like:
 *
 * ```ts
 * import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
 * import { makeWebsiteExports, DurableObjectBridge } from "alchemy/serve/worker";
 * import Site from "/abs/path/to/src/backend.ts";
 * export default makeWebsiteExports(WorkerEntrypoint, {
 *   site: Site,
 *   routes: ["/api/*"],
 *   framework: () => import("virtual:tanstack-start-server-entry"),
 * });
 * const Bridge = DurableObjectBridge(DurableObject, { site: Site });
 * export class Counter extends Bridge("Counter") {}
 * ```
 *
 * The class reuses the production Worker bridge wholesale
 * (`makeWorkerBridge` for non-fetch events and RPC, `getWorkerExport` for
 * the one-per-isolate layer build shared with the DO/Workflow bridges) and
 * overrides only `fetch`: strict route ownership — paths inside `routes`
 * go to the effect fetch, whose answer (404s included) is final; paths
 * outside go straight to the framework.
 *
 * This module only ever evaluates inside a worker bundle — there is no plan
 * world here — so the runtime flag is stamped at module evaluation.
 */

import * as Effect from "effect/Effect";
import cloudflare_workers from "../Cloudflare/Workers/cloudflare_workers.ts";
import { makeDurableObjectBridge } from "../Cloudflare/Workers/DurableObjectBridge.ts";
import {
  getWorkerExport,
  makeWorkerBridge,
} from "../Cloudflare/Workers/WorkerBridge.ts";
import { markRuntime, runSiteFetch } from "./Bridge.ts";
import { envString, hasStackMarkers, workersEnvOrEmpty } from "./Env.ts";
import { DEFAULT_SERVER_ROUTES, matchRoutes } from "./Routes.ts";
import type { AnyWebsiteClass } from "./Serve.ts";

markRuntime();

// Capture the workerd env for the stack-identity getters below. The import
// starts at module evaluation (see `cloudflare_workers.ts`) and has settled
// before the first event is dispatched — the only time the getters run.
void Effect.runPromise(cloudflare_workers).catch(() => {});

/**
 * The stack identity `makeWorkerBridge`/`makeDurableObjectBridge` expect.
 * Unlike the rolldown virtual entry (which bakes the values in at bundle
 * time), a wrapper in a foreign bundler graph learns them from the env
 * markers `putWorker` appends — read lazily, at layer-build time.
 */
const lazyStack = {
  get name(): string {
    return envString(workersEnvOrEmpty().ALCHEMY_STACK_NAME) ?? "";
  },
  get stage(): string {
    return envString(workersEnvOrEmpty().ALCHEMY_STAGE) ?? "";
  },
};

export interface WebsiteExportsOptions {
  /** The user's Website class (the default export of `src/backend.ts`). */
  site: AnyWebsiteClass;
  /**
   * Path globs the effect fetch owns (the construct's `server.routes`).
   * Requests outside the claim go straight to the framework; inside it
   * the effect fetch is authoritative (its 404s are real 404s).
   * @default DEFAULT_SERVER_ROUTES (["/api/*"])
   */
  routes?: readonly string[];
  /**
   * Lazy loader for the framework's server entry module (kept as a dynamic
   * `import()` thunk so the framework graph loads on first out-of-routes
   * request, not at wrapper evaluation). The module's `default.fetch` (or
   * `fetch`, or a default-exported function) serves every request outside
   * `routes`.
   */
  framework?: () => Promise<Record<string, any>>;
}

/**
 * Build the wrapper worker class: strict route ownership — the effect
 * fetch serves `routes` (its answers, 404s included, are final), the
 * framework serves everything else — plus the full non-fetch handler
 * surface (queue/scheduled/email/RPC) delivered by the underlying Worker
 * bridge dispatch.
 */
export const makeWebsiteExports = (
  Base: any,
  options: WebsiteExportsOptions,
): any => {
  const { site } = options;
  const routes = options.routes ?? DEFAULT_SERVER_ROUTES;
  const Bridge = makeWorkerBridge(Base, {
    entrypoint: site,
    stack: lazyStack,
  });
  const { build } = getWorkerExport({
    entrypoint: site,
    stack: lazyStack,
    exportName: "default",
  });

  let frameworkModule: Promise<Record<string, any> | undefined> | undefined;
  const frameworkFetch = async (
    request: Request,
    env: unknown,
    ctx: unknown,
  ): Promise<Response> => {
    const mod = await (frameworkModule ??=
      options.framework?.() ?? Promise.resolve(undefined));
    const target = mod?.default ?? mod;
    const fetchFn =
      typeof target?.fetch === "function"
        ? target.fetch.bind(target)
        : typeof target === "function"
          ? target
          : undefined;
    if (fetchFn === undefined) {
      return new Response("Not Found", { status: 404 });
    }
    return fetchFn(request, env, ctx);
  };

  return class WebsiteBridge extends Bridge {
    constructor(workerCtx: any, env: any) {
      super(workerCtx, env);
      // Single-listener law: delegation is composed inside ONE fetch
      // handler (routes decide effect vs framework) — never a second
      // registered listener, which the Worker runtime would fan out to
      // concurrently.
      (this as any).fetch = async (request: Request): Promise<Response> => {
        const ctx = (this as any).ctx;
        if (
          !hasStackMarkers(env) ||
          !matchRoutes(routes, new URL(request.url).pathname)
        ) {
          return frameworkFetch(request, env, ctx);
        }
        const built = await build((promise) => ctx.waitUntil(promise));
        const matched = await runSiteFetch(
          {
            context: built.context,
            shape: built.shape,
            telemetry: built.telemetry,
          },
          request,
          { executionContext: ctx },
        );
        // `undefined` only when the site exposes no fetch handler — inside
        // the routes the effect fetch's answer (404s included) is final.
        return matched ?? frameworkFetch(request, env, ctx);
      };
    }
  };
};

/**
 * Durable Object bridge factory for wrapper entries. Shares the
 * one-per-isolate layer build with {@link makeWebsiteExports} (both key on
 * the site class), so a DO activation and the default worker run the user's
 * init exactly once.
 *
 * ```ts
 * const Bridge = DurableObjectBridge(DurableObject, { site: Site });
 * export class Counter extends Bridge("Counter") {}
 * ```
 */
export const DurableObjectBridge = (
  Base: any,
  options: { site: AnyWebsiteClass },
): ((className: string) => any) =>
  makeDurableObjectBridge(Base, {
    entrypoint: options.site as any,
    stack: lazyStack,
  });
