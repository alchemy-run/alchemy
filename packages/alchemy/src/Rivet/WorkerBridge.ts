/**
 * The Rivet **runner-process bridge**: the Node/Bun half of the shared
 * worker runtime core. It builds a `Rivet.Worker` deploy module's layer
 * stack ONCE per process (`getSharedBuild`), resolves each hosted Durable
 * Object export against it, adapts every export into a rivetkit actor
 * (`DurableObjectBridge.ts`), registers the runner pool with the engine,
 * and serves until the engine drains the process.
 *
 * Rivet inverts the Cloudflare/celld model: nothing is uploaded to the
 * engine — the user's actor code runs in their OWN long-running process
 * (this one) that opens an outbound connection to the Rivet Engine.
 *
 * Two runner-specific pieces ride on the core's {@link SharedBuildOptions}:
 *
 * - the platform layer is Node-flavored (`NodeServices`, fetch client,
 *   console logger), not `cloudflare:workers`;
 * - there is no native Durable Object binding in the environment, so the
 *   environment record maps each hosted class name to a gateway-backed
 *   namespace — in-runner `getByName` round-trips through the engine,
 *   which routes to whichever runner owns the instance.
 *
 * `rivetkit` is imported dynamically: it ships wasm/napi engine sidecars
 * that cannot be bundled, so the runner bundle keeps it external and the
 * image environment installs it (see `EcsHost.ts`).
 *
 * @internal consumed by the generated runner entry, not by user code.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { DurableObjectExport } from "../Workers/DurableObject.ts";
import {
  getSharedBuild,
  getWorkerExport as getSharedWorkerExport,
  type SharedBuildOptions,
} from "../Workers/Worker.ts";
import {
  discoverDurableObjectMethods,
  makeRivetActor,
  type RivetActorFactory,
} from "./DurableObjectBridge.ts";
import {
  makeRivetActorClient,
  parseRivetEndpoint,
  RIVET_RUNNER_POOL,
} from "./Gateway.ts";

export interface RivetRunnerOptions {
  readonly stack: { readonly name: string; readonly stage: string };
  /**
   * The Durable Object classes hosted by this worker, discovered at plan
   * time and baked into the generated entry. Each gets a gateway-backed
   * namespace in the worker environment.
   */
  readonly classes: readonly { readonly className: string }[];
}

const runnerPlatform = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
);

/**
 * The runner half of the shared build: the process environment, read
 * once, plus a gateway-backed namespace client under each hosted Durable
 * Object class name (where workerd would surface the native binding).
 */
const runnerBuildOptions = (
  durableObjects: readonly string[],
): SharedBuildOptions => ({
  platform: runnerPlatform,
  env: Effect.sync(() => {
    const env: Record<string, unknown> = { ...process.env };
    const raw = env.RIVET_ENDPOINT;
    if (typeof raw === "string") {
      const connection = parseRivetEndpoint(raw);
      const pool =
        typeof env.RIVET_POOL === "string" ? env.RIVET_POOL : RIVET_RUNNER_POOL;
      for (const className of durableObjects) {
        env[className] = makeRivetActorClient(
          { ...connection, pool },
          className,
        );
      }
    }
    return env;
  }),
});

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
const ensureRunnerConfig = Effect.gen(function* () {
  const raw = yield* Config.option(Config.string("RIVET_ENDPOINT"));
  if (Option.isNone(raw)) {
    return;
  }
  const { endpoint, namespace, token } = parseRivetEndpoint(raw.value);
  const pool = yield* Config.string("RIVET_POOL").pipe(
    Effect.orElseSucceed(() => RIVET_RUNNER_POOL),
  );
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const headers: Record<string, string> =
    token === "" ? {} : { authorization: `Bearer ${token}` };
  const query = `namespace=${encodeURIComponent(namespace)}`;

  yield* Effect.gen(function* () {
    const { datacenters } = (yield* client
      .execute(
        HttpClientRequest.get(`${endpoint}/datacenters?${query}`).pipe(
          HttpClientRequest.setHeaders(headers),
        ),
      )
      .pipe(Effect.flatMap((response) => response.json))) as {
      datacenters: { name: string }[];
    };
    yield* client.execute(
      HttpClientRequest.put(
        `${endpoint}/runner-configs/${encodeURIComponent(pool)}?${query}`,
      ).pipe(
        HttpClientRequest.setHeaders(headers),
        HttpClientRequest.bodyJsonUnsafe({
          // Serverful pool: the "normal" variant with engine defaults.
          datacenters: Object.fromEntries(
            datacenters.map((dc) => [dc.name, { normal: {} }]),
          ),
        }),
      ),
    );
  }).pipe(Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 9 }));
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      FetchHttpClient.layer,
      Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv()),
    ),
  ),
);

/**
 * Build the worker's layer stack once, adapt each hosted Durable Object
 * into a Rivet actor, register the runner pool config, and serve until
 * drained. This is the runner container's entire process.
 */
export const bootstrap = async (
  entrypoint: object,
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

    const classNames = options.classes.map(({ className }) => className);
    const buildOptions = runnerBuildOptions(classNames);

    // One layer build for the whole process — the impl's init runs here,
    // exactly once; every class export below resolves against it.
    await getSharedBuild(entrypoint, options.stack, buildOptions)(() => {});

    const use: Record<string, unknown> = {};
    for (const className of classNames) {
      const { build } = getSharedWorkerExport<DurableObjectExport>(
        { entrypoint, stack: options.stack, exportName: className },
        buildOptions,
      );
      // Rivet reads an actor's `actions` map once at registration, so the
      // RPC surface must be complete up front: a startup probe of the
      // built shape.
      const methods = await discoverDurableObjectMethods(build).catch(
        (error: unknown) => {
          console.warn(
            `method discovery failed for Durable Object '${className}'`,
            error,
          );
          return [];
        },
      );
      use[className] = makeRivetActor(actor as unknown as RivetActorFactory, {
        build,
        methods,
        // Declared for every class so `storage.sql` is always available.
        db: (db as (config: unknown) => unknown)({
          onMigrate: async () => {},
        }),
      });
    }

    await Effect.runPromise(ensureRunnerConfig);
    // Connects to RIVET_ENDPOINT and serves the registered actors.
    // startAndWait (30s internal deadline) resolves only once the envoy has
    // registered with the engine — a runner that cannot register exits
    // nonzero rather than sitting "healthy" while serving nothing.
    await (
      setup as unknown as (config: { use: Record<string, unknown> }) => {
        startAndWait: () => Promise<void>;
      }
    )({ use }).startAndWait();
  } catch (error) {
    console.error("rivet runner failed to register with the engine", error);
    process.exit(1);
  }
};
