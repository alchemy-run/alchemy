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
import {
  discoverDurableObjectMethods,
  makeRivetActor,
  resolveWorkerExports,
} from "alchemy/Rivet";

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

// Rivet reads an actor's \`actions\` map once at registration, so the RPC
// surface must be complete up front: the plan-time-discovered list baked
// at bundle time, unioned with a startup probe of the built shape (the
// fallback for exports whose platform recorded no methods).
const actorMethods = async (name, baked) => {
  const discovered = await discoverDurableObjectMethods(exports[name]).catch(
    (error) => {
      console.warn(
        \`method discovery failed for Durable Object '\${name}' — \` +
          \`falling back to the baked list\`,
        error,
      );
      return [];
    },
  );
  return [...new Set([...baked, ...discovered])];
};

const use = {
${doClasses
  .map(
    ({
      className,
      methods,
    }) => `  ${JSON.stringify(className)}: makeRivetActor(actor, {
    export: exports[${JSON.stringify(className)}],
    methods: await actorMethods(${JSON.stringify(className)}, ${JSON.stringify(methods)}),
    // Declared for every class so \`storage.sql\` is always available.
    db: db({ onMigrate: async () => {} }),
  }),`,
  )
  .join("\n")}
};

// The engine only routes gateway \`getOrCreate\` calls for pools that have a
// runner config registered ("no_runner_config_configured" otherwise), and
// rivetkit's native runtime auto-upserts the serverful ("normal") config
// ONLY for local engine endpoints — against a remote engine the pool must
// be registered explicitly. The runner is the one component that always
// runs inside the engine's network with the admin token in hand, so it
// registers the config on every boot: an idempotent PUT that also restores
// the pool after an engine redeploy wiped its ephemeral store (on the next
// runner restart). Bounded retry (10 x 3s); a persistent failure exits the
// process so the supervisor (ECS) restarts it and the deploy's
// service-stability wait surfaces the fault instead of a silent hang.
const ensureRunnerConfig = async () => {
  const raw = process.env.RIVET_ENDPOINT;
  if (raw === undefined) return;
  const url = new URL(raw);
  const namespace = url.username
    ? decodeURIComponent(url.username)
    : "default";
  const token = url.password ? decodeURIComponent(url.password) : "";
  const pool = process.env.RIVET_POOL ?? "default";
  const headers = {
    "content-type": "application/json",
    ...(token !== "" ? { authorization: \`Bearer \${token}\` } : {}),
  };
  const query = \`namespace=\${encodeURIComponent(namespace)}\`;
  let lastError;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const dcsResponse = await fetch(
        \`\${url.origin}/datacenters?\${query}\`,
        { headers },
      );
      if (!dcsResponse.ok) {
        throw new Error(\`GET /datacenters -> \${dcsResponse.status}\`);
      }
      const { datacenters } = await dcsResponse.json();
      const response = await fetch(
        \`\${url.origin}/runner-configs/\${encodeURIComponent(pool)}?\${query}\`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({
            // Serverful pool: the "normal" variant with engine defaults.
            datacenters: Object.fromEntries(
              datacenters.map((dc) => [dc.name, { normal: {} }]),
            ),
          }),
        },
      );
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          \`PUT /runner-configs/\${pool} -> \${response.status}: \${body.slice(0, 256)}\`,
        );
      }
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
  throw lastError;
};

try {
  await ensureRunnerConfig();
  // Connects to RIVET_ENDPOINT and serves the registered actors.
  // startAndWait (30s internal deadline) resolves only once the envoy has
  // registered with the engine — a runner that cannot register exits
  // nonzero rather than sitting "healthy" while serving nothing.
  await setup({ use }).startAndWait();
} catch (error) {
  console.error("rivet runner failed to register with the engine", error);
  process.exit(1);
}
`;
};
