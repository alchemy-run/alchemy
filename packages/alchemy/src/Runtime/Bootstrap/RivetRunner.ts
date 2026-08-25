/**
 * Process bootstrap for Rivet **runner** containers. The generated entry is
 * a thin shim importing only `alchemy/Runtime/Bootstrap/RivetRunner` and
 * the user's `main` — see {@link ./Process.ts} for why the wiring lives in
 * a real module instead of an inline template string.
 *
 * Rivet inverts the celld/Cloudflare model: nothing is uploaded to the
 * engine — the user's actor code runs in their own long-running process (a
 * "runner") that opens an outbound WebSocket to the Rivet Engine. This
 * bootstrap IS that process: it resolves the worker's export map via
 * `resolveWorkerExports` (one layer build for the whole process), adapts
 * each Durable Object export into a Rivet actor via `makeRivetActor`, and
 * starts the rivetkit registry (which connects to `RIVET_ENDPOINT` and
 * begins serving actors).
 *
 * `rivetkit` is imported dynamically: it ships wasm/napi engine sidecars
 * that cannot be bundled, so the runner bundle keeps it external and the
 * image environment installs it (see `Rivet/EcsRunnerHost.ts`).
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  discoverDurableObjectMethods,
  resolveWorkerExports,
} from "../../Rivet/Runner.ts";
import { makeRivetActor } from "../../Rivet/ActorBridge.ts";

export interface RivetRunnerOptions {
  readonly stack: { readonly name: string; readonly stage: string };
  /**
   * The Durable Object classes hosted by this worker, with the plan-time
   * discovered RPC surface baked in at bundle time — Rivet reads an
   * actor's `actions` map once at registration, so the names must be known
   * before any instance exists (same constraint as celld's static-dispatch
   * mode, see `Runtime/Bootstrap/CelldFleet.ts`).
   */
  readonly classes: readonly {
    readonly className: string;
    readonly methods: readonly string[];
  }[];
}

/** Read one env-backed config value without touching `process.env`. */
const readConfig = (name: string): Promise<string | undefined> =>
  Effect.runPromise(
    Config.option(Config.string(name)).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
      Effect.map(Option.getOrUndefined),
    ),
  );

/**
 * Rivet reads an actor's `actions` map once at registration, so the RPC
 * surface must be complete up front: the plan-time-discovered list baked
 * at bundle time, unioned with a startup probe of the built shape (the
 * fallback for exports whose platform recorded no methods).
 */
const actorMethods = async (
  exported: any,
  name: string,
  baked: readonly string[],
): Promise<string[]> => {
  const discovered = await discoverDurableObjectMethods(exported).catch(
    (error) => {
      console.warn(
        `method discovery failed for Durable Object '${name}' — ` +
          "falling back to the baked list",
        error,
      );
      return [];
    },
  );
  return [...new Set([...baked, ...discovered])];
};

/**
 * The engine only routes gateway `getOrCreate` calls for pools that have a
 * runner config registered ("no_runner_config_configured" otherwise), and
 * rivetkit's native runtime auto-upserts the serverful ("normal") config
 * ONLY for local engine endpoints — against a remote engine the pool must
 * be registered explicitly. The runner is the one component that always
 * runs inside the engine's network with the admin token in hand, so it
 * registers the config on every boot: an idempotent PUT that also restores
 * the pool after an engine redeploy wiped its ephemeral store (on the next
 * runner restart). Bounded retry (10 x 3s); a persistent failure exits the
 * process so the supervisor (ECS) restarts it and the deploy's
 * service-stability wait surfaces the fault instead of a silent hang.
 */
const ensureRunnerConfig = async (): Promise<void> => {
  const raw = await readConfig("RIVET_ENDPOINT");
  if (raw === undefined) return;
  const url = new URL(raw);
  const namespace = url.username ? decodeURIComponent(url.username) : "default";
  const token = url.password ? decodeURIComponent(url.password) : "";
  const pool = (await readConfig("RIVET_POOL")) ?? "default";
  const headers = {
    "content-type": "application/json",
    ...(token !== "" ? { authorization: `Bearer ${token}` } : {}),
  };
  const query = `namespace=${encodeURIComponent(namespace)}`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const dcsResponse = await fetch(`${url.origin}/datacenters?${query}`, {
        headers,
      });
      if (!dcsResponse.ok) {
        throw new Error(`GET /datacenters -> ${dcsResponse.status}`);
      }
      const { datacenters } = (await dcsResponse.json()) as {
        datacenters: { name: string }[];
      };
      const response = await fetch(
        `${url.origin}/runner-configs/${encodeURIComponent(pool)}?${query}`,
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
          `PUT /runner-configs/${pool} -> ${response.status}: ${body.slice(0, 256)}`,
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

/**
 * Resolve the worker's exports, adapt each hosted Durable Object into a
 * Rivet actor, register the runner pool config, and serve until drained.
 */
export const bootstrap = async (
  entrypoint: unknown,
  options: RivetRunnerOptions,
): Promise<void> => {
  try {
    // Dynamic imports: rivetkit stays external to the runner bundle (its
    // wasm/napi sidecars cannot be bundled) and resolves from the image's
    // installed node_modules.
    const [{ actor, setup }, { db }] = await Promise.all([
      import("rivetkit"),
      import("rivetkit/db"),
    ]);

    // One layer build for the whole process — the impl's init runs here,
    // then each Durable Object export is adapted into a Rivet actor.
    const exports = await resolveWorkerExports(entrypoint, {
      stack: options.stack,
      durableObjects: options.classes.map(({ className }) => className),
    });

    const use: Record<string, unknown> = {};
    for (const { className, methods } of options.classes) {
      use[className] = makeRivetActor(actor as any, {
        export: exports[className],
        methods: await actorMethods(exports[className], className, methods),
        // Declared for every class so `storage.sql` is always available.
        db: (db as any)({ onMigrate: async () => {} }),
      });
    }

    await ensureRunnerConfig();
    // Connects to RIVET_ENDPOINT and serves the registered actors.
    // startAndWait (30s internal deadline) resolves only once the envoy has
    // registered with the engine — a runner that cannot register exits
    // nonzero rather than sitting "healthy" while serving nothing.
    await (setup as any)({ use }).startAndWait();
  } catch (error) {
    console.error("rivet runner failed to register with the engine", error);
    process.exit(1);
  }
};
