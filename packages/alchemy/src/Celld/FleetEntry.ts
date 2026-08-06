/**
 * The generated virtual-entry module for Celld fleet bundles.
 *
 * A fleet deploys the same Effect worker artifact Cloudflare Workers do —
 * `makeWorkerBridge` for the default fetch path and `makeDurableObjectBridge`
 * for each Durable Object class — with one divergence: celld's loader
 * requires the main worker to be the **object form** (`export default
 * { fetch }`), not a `WorkerEntrypoint` subclass. The generated entry
 * instantiates the bridge class per event and delegates; the expensive
 * isolate build inside the bridge is module-memoized, so per-event
 * instantiation costs a closure, not a rebuild.
 *
 * @internal not exported from the Celld barrel.
 */
import {
  isDurableObjectExport,
  type DurableObjectExport,
} from "../Cloudflare/Workers/DurableObject.ts";
import type { WorkflowExport } from "../Cloudflare/Workflows/Workflow.ts";

export const makeCelldVirtualEntry = (
  exports: Record<string, DurableObjectExport | WorkflowExport>,
  stack: { name: string; stage: string },
) => {
  const doClasses = Object.entries(exports)
    .filter((entry): entry is [string, DurableObjectExport] =>
      isDurableObjectExport(entry[1]),
    )
    .map(([className, entry]) => ({
      className,
      methods: entry.methods ?? [],
    }));
  return (importPath: string) => `
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { makeDurableObjectBridge, makeWorkerBridge } from "alchemy/Cloudflare";

import entrypoint from ${JSON.stringify(importPath)};

const meta = {
  entrypoint,
  stack: {
    name: ${JSON.stringify(stack.name)},
    stage: ${JSON.stringify(stack.stage)},
  },
};

const WorkerBridge = makeWorkerBridge(WorkerEntrypoint, meta);

// celld's loader requires the object-form main worker; the bridge class is
// instantiated per event (the isolate build inside it is memoized).
export default {
  fetch: (request, env, ctx) => new WorkerBridge(ctx, env).fetch(request),
};

${
  doClasses.length > 0
    ? [
        "const DurableObjectBridge = makeDurableObjectBridge(DurableObject, meta);",
        // The plan-time-discovered method list is baked in: celld's JSRPC
        // dispatch stalls on Proxy-returning constructors, so the bridge
        // materializes these as real instance methods (see
        // DurableObjectBridge.ts).
        ...doClasses.map(
          ({ className, methods }) =>
            `export class ${className} extends DurableObjectBridge(${JSON.stringify(className)}, ${JSON.stringify(methods)}) {}`,
        ),
      ].join("\n")
    : ""
}
`;
};
