/**
 * Bootstrap for Celld **fleet** Worker bundles. The generated entry is a
 * thin shim importing only `cloudflare:workers` (runtime-provided),
 * `alchemy/Runtime/Bootstrap/CelldFleet`, and the user's `main` — see
 * {@link ./Process.ts} for why the wiring lives in a real module instead of
 * an inline template string.
 *
 * A fleet deploys the same Effect worker artifact Cloudflare Workers do —
 * `makeWorkerBridge` for the default fetch path and
 * `makeDurableObjectBridge` for each Durable Object class — with one
 * divergence: celld's loader requires the main worker to be the **object
 * form** (`export default { fetch }`), not a `WorkerEntrypoint` subclass.
 * The bootstrap instantiates the bridge class per event and delegates; the
 * expensive isolate build inside the bridge is module-memoized, so
 * per-event instantiation costs a closure, not a rebuild.
 *
 * The `cloudflare:workers` base classes are passed in by the shim (they
 * are only importable inside the workers runtime), mirroring how the
 * bridge factories themselves are parameterized.
 */
import { makeDurableObjectBridge } from "../../Cloudflare/Workers/DurableObjectBridge.ts";
import { makeWorkerBridge } from "../../Cloudflare/Workers/WorkerBridge.ts";

export interface CelldFleetBootstrap {
  /** The object-form main worker celld's loader requires. */
  readonly default: {
    readonly fetch: (request: any, env: any, ctx: any) => any;
  };
  /**
   * Build the exported Durable Object bridge class for one hosted class.
   * The plan-time-discovered `methods` are baked in by the shim: celld's
   * JSRPC dispatch stalls on Proxy-returning constructors, so the bridge
   * materializes them as real instance methods (see DurableObjectBridge.ts).
   */
  readonly durableObject: (className: string, methods: string[]) => any;
}

export const makeFleetBootstrap = (
  base: {
    /** `DurableObject` from `cloudflare:workers`. */
    readonly DurableObject: any;
    /** `WorkerEntrypoint` from `cloudflare:workers`. */
    readonly WorkerEntrypoint: any;
  },
  entrypoint: unknown,
  options: {
    readonly stack: { readonly name: string; readonly stage: string };
  },
): CelldFleetBootstrap => {
  const meta = {
    entrypoint: entrypoint as any,
    stack: { name: options.stack.name, stage: options.stack.stage },
  };
  const WorkerBridge = makeWorkerBridge(base.WorkerEntrypoint, meta);
  let DurableObjectBridge:
    | ReturnType<typeof makeDurableObjectBridge>
    | undefined;
  return {
    // celld's loader requires the object-form main worker; the bridge class
    // is instantiated per event (the isolate build inside it is memoized).
    default: {
      fetch: (request: any, env: any, ctx: any) =>
        new (WorkerBridge as any)(ctx, env).fetch(request),
    },
    durableObject: (className: string, methods: string[]) =>
      (DurableObjectBridge ??= makeDurableObjectBridge(
        base.DurableObject,
        meta,
      ))(className, methods),
  };
};
