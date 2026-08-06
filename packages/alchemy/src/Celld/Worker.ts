/**
 * A **Celld Worker**: the application deployed onto a {@link Fleet}. Fleet
 * nodes execute the Worker's bundle — the same artifact Cloudflare Workers
 * deploy — so a Worker serves HTTP via its `fetch` handler and **contains
 * the Durable Object classes** provided on its impl (celld runs one Worker
 * deployment per fleet).
 *
 * The Worker's provider is the deployment reconciler: it bundles the impl
 * (with the fleet RPC gateway wrapped around `fetch`), stages a wrangler
 * project, runs `celld deploy` (a pure bucket write via the pinned CLI),
 * and rolls the fleet's nodes so they load the new version.
 *
 * @section Deploying a Worker
 * @example A Worker hosting a Counter on a Fleet
 * ```typescript
 * // worker.ts — tag-only class
 * export class CellsWorker extends Celld.Worker<CellsWorker>()("CellsWorker") {}
 *
 * // main.ts — the deployable module
 * export default CellsWorker.make(
 *   { fleet: Cells, main: import.meta.url },
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const n = yield* counters.getByName("lobby").increment();
 *         return HttpServerResponse.text(String(n));
 *       }),
 *     };
 *   }).pipe(Effect.provide(CounterLive)),
 * );
 * ```
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Artifacts from "../Artifacts.ts";
import type { Main } from "../Platform.ts";
import { Platform, type PlatformProps } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import {
  Resource,
  isResourceOfType,
  type ResourceBinding,
} from "../Resource.ts";
import { packEnvValue } from "../RuntimeContext.ts";
import { Stack } from "../Stack.ts";
import { asEffect } from "../Util/types.ts";
import type { WorkerEnvironment } from "../Cloudflare/Workers/Worker.ts";
import type { WorkerBuildOptions } from "../Cloudflare/Workers/Sources/Rolldown.ts";
import { WorkerBundle } from "../Cloudflare/Workers/Sources/Rolldown.ts";
import { DEFAULT_CELLD_VERSION, celldDeploy } from "./CelldCli.ts";
import type { Fleet } from "./Fleet.ts";
import { makeCelldVirtualEntry } from "./FleetEntry.ts";
import { FLEET_DEPLOYMENT_VAR, FLEET_SECRET_VAR } from "./FleetGateway.ts";
import { findFleetHost, type FleetBucket } from "./FleetHost.ts";
import {
  makeFleetRuntimeContext,
  type FleetRuntimeContext,
} from "./FleetRuntimeContext.ts";
import { WorkerTypeId } from "./FleetTypes.ts";
import type { Providers } from "./Providers.ts";
import {
  computeFleetMigrations,
  renderWranglerJson,
  type CelldMigration,
  type FleetDurableObjectBinding,
} from "./Wrangler.ts";

/**
 * A reference to a {@link Fleet} or {@link Worker} class: the class itself
 * (a Platform class is an Effect with a static `LogicalId`), or a thunk for
 * forward references / import cycles.
 */
export type ClassRef =
  | Effect.Effect<any, any, any>
  | { readonly LogicalId: string }
  | (() => ClassRef);

/** @internal */
export const resolveClassRef = (
  ref: ClassRef,
  depth = 0,
): { LogicalId: string } => {
  if (
    ref !== null &&
    typeof (ref as { LogicalId?: unknown }).LogicalId === "string"
  ) {
    return ref as unknown as { LogicalId: string };
  }
  if (typeof ref === "function" && depth < 8) {
    return resolveClassRef((ref as () => ClassRef)(), depth + 1);
  }
  throw new Error(
    "Invalid class reference: pass the class itself (or a thunk of it).",
  );
};

export interface WorkerProps extends PlatformProps {
  /** The {@link Fleet} this Worker deploys onto. */
  fleet?: ClassRef | string;
  /**
   * Entry module of the Worker bundle, usually `import.meta.url`.
   */
  main?: string;
  /**
   * The celld release the managed deploy CLI is pinned to.
   * @default DEFAULT_CELLD_VERSION
   */
  celldVersion?: string;
  /**
   * Workers compatibility date for the bundle.
   * @default "2025-06-01"
   */
  compatibilityDate?: string;
  /**
   * Workers compatibility flags for the bundle.
   * @default ["nodejs_compat"]
   */
  compatibilityFlags?: string[];
  /** Bundler configuration overrides. */
  build?: WorkerBuildOptions;
  /** Extra environment variables (wrangler `vars`) for the Worker. */
  env?: Record<string, any>;
  /**
   * Durable Object / export map. Populated automatically from the impl;
   * do not set manually.
   * @internal
   */
  exports?: Record<string, any>;
  /** Copied from the fleet by `transformProps` — never set manually. @internal */
  hostKind?: string;
  /** Copied from the fleet by `transformProps` — never set manually. @internal */
  bucket?: FleetBucket;
  /** Copied from the fleet by `transformProps` — never set manually. @internal */
  fleetUrl?: string;
  /** Copied from the fleet by `transformProps` — never set manually. @internal */
  fleetSecret?: Redacted.Redacted<string>;
  /** Copied from the fleet by `transformProps` — never set manually. @internal */
  hostState?: Record<string, any>;
}

/**
 * The binding contract of a Worker: Durable Object class declarations plus
 * environment variables (wrangler `vars`).
 */
export interface WorkerBindingContract {
  env?: Record<string, any>;
  durableObjects?: FleetDurableObjectBinding[];
}

export interface Worker extends Resource<
  WorkerTypeId,
  WorkerProps,
  {
    /** Physical worker name (the wrangler project name). */
    workerName: string;
    /** The fleet endpoint this Worker serves on (VPC-internal). */
    fleetUrl: string;
    /** The fleet auth secret checked by the RPC gateway. */
    fleetSecret: Redacted.Redacted<string>;
    /** The S3-compatible bucket backing the fleet. */
    bucket: FleetBucket;
    /** The {@link FleetHost} kind running the fleet's nodes. */
    hostKind: string;
    /** Host-specific state (compute identifiers, network attachment). */
    hostState: Record<string, any> | undefined;
    /** The alchemy deployment id (bundle content hash). */
    deploymentId: string;
    /** celld's version id for the last deploy. */
    versionId: string | undefined;
    /** The persisted `logicalId → className` map — the migration baseline. */
    durableObjectClasses: Record<string, string>;
    /** The full migration history (wrangler `migrations`). */
    migrations: CelldMigration[];
    code: { hash: string };
  },
  WorkerBindingContract,
  Providers
> {}

export const isCelldWorker = <T>(value: T): value is T & Worker =>
  isResourceOfType(value, WorkerTypeId);

/** Services available to a Worker impl's init effect. */
export type WorkerServices = Worker | WorkerEnvironment;

/** The impl shape of a Worker: an optional `fetch` handler. */
export type WorkerShape = Main<WorkerServices>;

/**
 * Resolve the `fleet` reference and copy its connection material onto the
 * Worker's props (deep `Input` resolution turns the fleet's attribute
 * Outputs into plain values at reconcile, and the reference orders the
 * fleet ahead of the Worker in the graph). A no-op at runtime.
 */
const transformWorkerProps = (
  _id: string,
  props: WorkerProps,
): Effect.Effect<WorkerProps, unknown, any> =>
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__ || props.fleet === undefined) {
      return props;
    }
    const fleet = (yield* asEffect(
      resolveClassRef(props.fleet as ClassRef) as any,
    )) as Fleet;
    return {
      ...props,
      fleet: fleet.LogicalId,
      // The host KIND must be plan-readable (it keys the dynamic FleetHost
      // lookup) — the fleet's transformed Props carry it as a plain string,
      // unlike the attribute accessor, which is an Output.
      hostKind:
        (fleet as { Props?: { hostKind?: string } }).Props?.hostKind ??
        fleet.hostKind,
      bucket: fleet.bucket,
      fleetUrl: fleet.fleetUrl,
      fleetSecret: fleet.fleetSecret,
      hostState: fleet.hostState,
      // The copied fields are the fleet's attribute Outputs — deep `Input`
      // resolution turns them into the plain values `WorkerProps` declares
      // by the time the provider sees them.
    } as unknown as WorkerProps;
  });

export const Worker: Platform<
  Worker,
  WorkerServices,
  WorkerShape,
  FleetRuntimeContext
> = Platform(WorkerTypeId, {
  createRuntimeContext: makeFleetRuntimeContext,
  transformProps: transformWorkerProps,
});

const DEFAULT_COMPATIBILITY_DATE = "2025-06-01";
const DEFAULT_COMPATIBILITY_FLAGS = ["nodejs_compat"];

/** Render a wrangler `vars` value: strings verbatim, everything else packed
 * so the runtime `get` accessor round-trips it (Redacted markers included). */
const renderVar = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Redacted.isRedacted(value)
      ? Redacted.value(value as Redacted.Redacted<any>)
      : packEnvValue(value);

export const WorkerProvider = () =>
  Provider.effect(
    Worker,
    Effect.gen(function* () {
      const stack = yield* Stack;

      const collectBindings = (
        bindings: ResourceBinding<WorkerBindingContract>[] | undefined,
      ) => {
        const active = (bindings ?? []).filter(
          (
            binding: ResourceBinding<WorkerBindingContract> & {
              action?: string;
            },
          ) => binding.action !== "delete",
        );
        const durableObjects = new Map<string, FleetDurableObjectBinding>();
        const env: Record<string, unknown> = {};
        for (const binding of active) {
          for (const declaration of binding.data?.durableObjects ?? []) {
            durableObjects.set(declaration.name, declaration);
          }
          Object.assign(env, binding.data?.env ?? {});
        }
        return { durableObjects: [...durableObjects.values()], env };
      };

      const buildBundle = (id: string, news: WorkerProps) =>
        Effect.gen(function* () {
          const bundler = yield* WorkerBundle;
          return yield* bundler.build({
            id,
            main: news.main!,
            compatibility: {
              date: news.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
              flags: news.compatibilityFlags ?? DEFAULT_COMPATIBILITY_FLAGS,
            },
            entry: {
              kind: "effect",
              exports: news.exports ?? {},
              makeVirtualEntry: makeCelldVirtualEntry,
            },
            stack: { name: stack.name, stage: stack.stage },
            extraOptions: news.build,
          });
        }).pipe(Artifacts.cached("build"));

      const workerName = (id: string) =>
        `${stack.name}-${stack.stage}-${id}`.toLowerCase();

      return {
        stables: ["workerName", "bucket", "hostKind"],

        read: ({ output }: { output: Worker["Attributes"] | undefined }) =>
          Effect.succeed(output),

        diff: ({
          id,
          news,
          output,
        }: {
          id: string;
          news: any;
          output: Worker["Attributes"] | undefined;
        }) =>
          Effect.gen(function* () {
            // Surface source drift that prop comparison can't see: build
            // (cached — shared with reconcile in the same run) and compare
            // content hashes. Skip when `main` is still an unresolved Input.
            if (output === undefined || typeof news?.main !== "string") {
              return undefined;
            }
            const bundle = yield* buildBundle(id, news as WorkerProps);
            if (bundle.hash !== output.code?.hash) {
              return { action: "update" as const };
            }
            return undefined;
          }),

        reconcile: Effect.fn(function* ({
          id,
          news,
          output,
          bindings,
          session,
        }: {
          id: string;
          news: WorkerProps;
          olds: WorkerProps | undefined;
          output: Worker["Attributes"] | undefined;
          session: { note: (message: string) => Effect.Effect<void> };
          bindings: ResourceBinding<WorkerBindingContract>[];
        }) {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          if (news.main === undefined) {
            return yield* Effect.die(
              new Error(`Celld.Worker '${id}' requires a 'main' entry module.`),
            );
          }
          if (
            news.bucket === undefined ||
            news.fleetUrl === undefined ||
            news.fleetSecret === undefined ||
            news.hostKind === undefined
          ) {
            return yield* Effect.die(
              new Error(
                `Celld.Worker '${id}' has no fleet connection — declare the ` +
                  "fleet it deploys onto: Worker.make({ fleet, main }, impl).",
              ),
            );
          }

          const host = yield* findFleetHost(news.hostKind);
          const { durableObjects, env: bindingEnv } = collectBindings(bindings);

          // Migration delta against the persisted class map — typed
          // fail-before-deploy on conflicts.
          const { migrations, classes } = yield* computeFleetMigrations({
            history: output?.migrations,
            oldClasses: output?.durableObjectClasses,
            current: durableObjects,
          });

          yield* session.note("bundling worker");
          const bundle = yield* buildBundle(id, news);
          const deploymentId = bundle.hash.slice(0, 16);

          // Stage the wrangler project.
          const staged = yield* fs.makeTempDirectory({
            prefix: "alchemy-celld-",
          });
          for (const file of bundle.files) {
            const target = path.join(staged, file.path);
            yield* fs.makeDirectory(path.dirname(target), { recursive: true });
            if (typeof file.content === "string") {
              yield* fs.writeFileString(target, file.content);
            } else {
              yield* fs.writeFile(target, file.content);
            }
          }
          const vars: Record<string, string> = {};
          for (const [key, value] of Object.entries({
            ...news.env,
            ...bindingEnv,
          })) {
            if (value !== undefined) {
              vars[key] = renderVar(value);
            }
          }
          vars[FLEET_SECRET_VAR] = Redacted.value(news.fleetSecret);
          vars[FLEET_DEPLOYMENT_VAR] = deploymentId;
          yield* fs.writeFileString(
            path.join(staged, "wrangler.json"),
            renderWranglerJson({
              name: workerName(id),
              main: bundle.files[0].path,
              compatibilityDate:
                news.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
              compatibilityFlags:
                news.compatibilityFlags ?? DEFAULT_COMPATIBILITY_FLAGS,
              durableObjects,
              migrations,
              vars,
            }),
          );

          // Deploy — a pure bucket write via the pinned celld CLI, with
          // standard-chain credentials resolved by the fleet host.
          yield* session.note("celld deploy");
          const deployEnv = yield* host.deployEnv({ news });
          const { versionId } = yield* celldDeploy({
            projectDir: staged,
            bucket: news.bucket.uri,
            endpoint: news.bucket.endpoint,
            region: news.bucket.region,
            env: deployEnv,
            version: news.celldVersion ?? DEFAULT_CELLD_VERSION,
          });
          yield* fs
            .remove(staged, { recursive: true })
            .pipe(Effect.catch(() => Effect.void));

          // celld nodes load a deployment at startup — roll them when the
          // deployed content changed. On the FIRST deploy the nodes' own
          // supervision loop picks the deployment up (they retry until one
          // exists), so no roll is needed.
          if (output !== undefined && output.deploymentId !== deploymentId) {
            yield* session.note("restarting fleet nodes");
            yield* host.restartNodes({ news });
          }

          return {
            workerName: workerName(id),
            fleetUrl: news.fleetUrl,
            fleetSecret: news.fleetSecret,
            bucket: news.bucket,
            hostKind: news.hostKind,
            hostState: news.hostState,
            deploymentId,
            versionId,
            durableObjectClasses: classes,
            migrations,
            code: { hash: bundle.hash },
          };
        }),

        // The deployment object lives in the fleet's bucket, which the fleet
        // host tears down with the rest of its children — nothing to delete
        // here.
        delete: () => Effect.void,
      };
    }),
  );
