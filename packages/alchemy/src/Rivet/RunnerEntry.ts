/**
 * The generated entry module for Rivet **runner** bundles.
 *
 * Rivet inverts the celld/Cloudflare model: nothing is uploaded to the
 * engine — the user's actor code runs in their own long-running process (a
 * "runner") that opens an outbound WebSocket to the Rivet Engine. This
 * entry IS that process: it imports the deployable module, resolves the
 * worker's export map via `resolveWorkerExports` (one layer build for the
 * whole process), adapts each Durable Object export into a Rivet actor via
 * `makeRivetActor`, and starts the rivetkit registry (which connects to
 * `RIVET_ENDPOINT` and begins serving actors).
 *
 * Per-class `methods` are the plan-time-discovered RPC surface baked in at
 * bundle time — Rivet reads an actor's `actions` map once at registration,
 * so the names must be known before any instance exists (same constraint
 * as celld's static-dispatch mode, see `Celld/FleetEntry.ts`).
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
  const doClasses = Object.entries(exports ?? {})
    .filter((entry): entry is [string, DurableObjectExport] =>
      isDurableObjectExport(entry[1]),
    )
    .map(([className, entry]) => ({
      className,
      methods: entry.methods ?? [],
    }));
  const classNames = doClasses.map(({ className }) => className);

  return (importPath: string) => `
import { actor, setup } from "rivetkit";
import { db } from "rivetkit/db";
import { makeRivetActor, resolveWorkerExports } from "alchemy/Rivet";

import entrypoint from ${JSON.stringify(importPath)};

// One layer build for the whole process — the impl's init runs here, then
// each Durable Object export is adapted into a Rivet actor.
const exports = await resolveWorkerExports(entrypoint, {
  stack: {
    name: ${JSON.stringify(stack.name)},
    stage: ${JSON.stringify(stack.stage)},
  },
  durableObjects: ${JSON.stringify(classNames)},
});

const use = {
${doClasses
  .map(
    ({
      className,
      methods,
    }) => `  ${JSON.stringify(className)}: makeRivetActor(actor, {
    export: exports[${JSON.stringify(className)}],
    methods: ${JSON.stringify(methods)},
    // Declared for every class so \`storage.sql\` is always available.
    db: db({ onMigrate: async () => {} }),
  }),`,
  )
  .join("\n")}
};

// Connects to RIVET_ENDPOINT and serves the registered actors.
setup({ use }).start();
`;
};
