/**
 * The generated virtual-entry module for Celld fleet bundles: a thin shim
 * importing only `cloudflare:workers` (runtime-provided), the real
 * bootstrap module `alchemy/Runtime/Bootstrap/CelldFleet` (resolvable from
 * any consumer — `alchemy` is its direct dependency), and the user's
 * `main`. Everything alchemy needs lives in that real module, so the
 * virtual entry never imports alchemy's own dependencies, which an
 * isolated install cannot resolve from the consumer's project (see
 * `Runtime/Bootstrap/Process.ts`).
 *
 * The per-class `export class` statements stay in the shim — celld's
 * loader requires statically named exports — with the plan-time-discovered
 * method lists baked in (celld's JSRPC dispatch stalls on Proxy-returning
 * constructors, so the bridge materializes them as real instance methods).
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
import { makeFleetBootstrap } from "alchemy/Runtime/Bootstrap/CelldFleet";
import entrypoint from ${JSON.stringify(importPath)};

const fleet = makeFleetBootstrap({ DurableObject, WorkerEntrypoint }, entrypoint, {
  stack: {
    name: ${JSON.stringify(stack.name)},
    stage: ${JSON.stringify(stack.stage)},
  },
});

export default fleet.default;

${doClasses
  .map(
    ({ className, methods }) =>
      `export class ${className} extends fleet.durableObject(${JSON.stringify(className)}, ${JSON.stringify(methods)}) {}`,
  )
  .join("\n")}
`;
};
