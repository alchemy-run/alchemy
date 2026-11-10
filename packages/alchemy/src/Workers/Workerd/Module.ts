import * as Effect from "effect/Effect";

/**
 * The parts of workerd's `cloudflare:workers` builtin module the shared
 * bridges read. Engines cast {@link workerdModule} to the full module type
 * from `@cloudflare/workers-types`.
 */
export interface WorkerdModule {
  readonly env: Record<string, unknown>;
  readonly [key: string]: any;
}

// Start the import at module evaluation (legal since workerd's 2025-03
// importable-env change) so the isolate-lifetime layer build that awaits it
// only ever sees an already-settled promise. This keeps the first event's
// build free of I/O-backed awaits: everything after this is pure layer
// assembly plus scheduler microtasks. Outside workerd (deploy/plan in Node,
// vitest) the import rejects and the fallback stub is used; the `.catch` is
// attached immediately so the rejection is always handled.
const moduleImport = import(
  // @ts-ignore -- a workerd builtin, typed only where `@cloudflare/workers-types` is loaded
  "cloudflare:workers"
) as Promise<any> as Promise<WorkerdModule>;
const modulePromise: Promise<WorkerdModule> = moduleImport.catch((): WorkerdModule => ({
  env: {},
  DurableObject: class {},
  WorkflowEntrypoint: class {
    async run() {}
  },
}));

/** workerd's `cloudflare:workers` module (a stub outside workerd). */
const workerdModule: Effect.Effect<WorkerdModule> = Effect.promise(() => modulePromise);

export default workerdModule;
