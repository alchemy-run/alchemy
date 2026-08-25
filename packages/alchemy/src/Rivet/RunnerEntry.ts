/**
 * The generated entry module for Rivet **runner** bundles: a thin shim
 * importing only the real bootstrap module
 * `alchemy/Runtime/Bootstrap/RivetRunner` (resolvable from any consumer —
 * `alchemy` is its direct dependency) plus the user's `main`. Everything
 * the runner needs lives in that real module, so the generated entry never
 * imports alchemy's own dependencies, which an isolated install cannot
 * resolve from the consumer's project (see `Runtime/Bootstrap/Process.ts`).
 *
 * The plan-time-discovered per-class RPC surface is baked into the shim as
 * plain data — Rivet reads an actor's `actions` map once at registration,
 * so the names must be known before any instance exists.
 *
 * @internal not exported from the Rivet barrel.
 */
import {
  isDurableObjectExport,
  type DurableObjectExport,
} from "../Cloudflare/Workers/DurableObject.ts";

export const makeRivetRunnerEntry = (
  exports: Record<string, unknown>,
  stack: { name: string; stage: string },
) => {
  const classes = Object.entries(exports ?? {})
    .filter((entry): entry is [string, DurableObjectExport] =>
      isDurableObjectExport(entry[1]),
    )
    .map(([className, entry]) => ({
      className,
      methods: entry.methods ?? [],
    }));

  return (importPath: string) => `
import { bootstrap } from "alchemy/Runtime/Bootstrap/RivetRunner";
import entrypoint from ${JSON.stringify(importPath)};

await bootstrap(entrypoint, {
  stack: {
    name: ${JSON.stringify(stack.name)},
    stage: ${JSON.stringify(stack.stage)},
  },
  classes: ${JSON.stringify(classes)},
});
`;
};
