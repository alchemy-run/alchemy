/**
 * A **Celld fleet**: a self-hosted Durable Object runtime built on
 * [celld](https://github.com/denoland/celld). Fleet nodes embed V8 and
 * execute the fleet's Worker bundle; cells (Durable Object instances)
 * coordinate ownership through CAS leases on an S3-compatible bucket and
 * replicate their SQLite state there before acknowledging writes.
 *
 * The fleet is host-agnostic: WHERE the nodes run (and which bucket backs
 * them) is owned by a pluggable {@link FleetHost} contributed by a cloud
 * provider layer — `AWS.providers()` registers the `aws-ecs` host. The
 * fleet's own provider is the **deployment reconciler**: it bundles the
 * Worker (the same artifact Cloudflare Workers deploy, plus the fleet RPC
 * gateway), stages a wrangler project, runs `celld deploy` (a pure bucket
 * write), and rolls the nodes so they load the new version.
 *
 * @section Hosting Durable Objects
 * @example A fleet hosting a Counter
 * ```typescript
 * // cells.ts — tag-only fleet class
 * export class Cells extends Celld.Fleet<Cells>()("Cells") {}
 *
 * // fleet.ts — the deployable module
 * export default Cells.make(
 *   { main: import.meta.url, instances: 2 },
 *   Effect.gen(function* () {
 *     yield* Counter;
 *     return {};
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
import type { WorkerEnvironment } from "../Cloudflare/Workers/Worker.ts";
import type { WorkerBuildOptions } from "../Cloudflare/Workers/Sources/Rolldown.ts";
import { WorkerBundle } from "../Cloudflare/Workers/Sources/Rolldown.ts";
import { DEFAULT_CELLD_VERSION, celldDeploy } from "./CelldCli.ts";
import { makeCelldVirtualEntry } from "./FleetEntry.ts";
import { FLEET_DEPLOYMENT_VAR, FLEET_SECRET_VAR } from "./FleetGateway.ts";
import {
  findFleetHost,
  resolveFleetHost,
  type FleetBucket,
  type FleetHostProps,
} from "./FleetHost.ts";
import {
  makeFleetRuntimeContext,
  type FleetRuntimeContext,
} from "./FleetRuntimeContext.ts";
import type { Providers } from "./Providers.ts";
import { FleetTypeId } from "./FleetTypes.ts";
import {
  computeFleetMigrations,
  renderWranglerJson,
  type CelldMigration,
  type FleetDurableObjectBinding,
} from "./Wrangler.ts";

export interface FleetProps extends PlatformProps {
  /**
   * Entry module of the fleet Worker bundle, usually `import.meta.url`.
   */
  main?: string;
  /**
   * Which registered {@link FleetHost} runs the fleet's nodes, plus its
   * host-specific options. When omitted, the sole registered host is used.
   */
  host?: FleetHostProps;
  /**
   * Number of fleet nodes.
   * @default 2
   */
  instances?: number;
  /**
   * The celld release the managed CLI (and default node image) is pinned to.
   * @default DEFAULT_CELLD_VERSION
   */
  celldVersion?: string;
  /**
   * Container image the fleet's nodes run.
   * @default ghcr.io/denoland/celld:{celldVersion}
   */
  image?: string;
  /**
   * Workers compatibility date for the fleet bundle.
   * @default "2025-06-01"
   */
  compatibilityDate?: string;
  /**
   * Workers compatibility flags for the fleet bundle.
   * @default ["nodejs_compat"]
   */
  compatibilityFlags?: string[];
  /** Bundler configuration overrides. */
  build?: WorkerBuildOptions;
  /** Extra environment variables (wrangler `vars`) for the fleet Worker. */
  env?: Record<string, any>;
  /** Tags applied to host-composed cloud resources. */
  tags?: Record<string, string>;
  /**
   * Durable Object / export map. Populated automatically from the fleet
   * impl; do not set manually.
   * @internal
   */
  exports?: Record<string, any>;
  /** Written by the fleet host's `compose` — never set manually. @internal */
  hostKind?: string;
  /** Written by the fleet host's `compose` — never set manually. @internal */
  bucket?: FleetBucket;
  /** Written by the fleet host's `compose` — never set manually. @internal */
  fleetUrl?: string;
  /** Written by the fleet host's `compose` — never set manually. @internal */
  fleetSecret?: Redacted.Redacted<string>;
  /** Written by the fleet host's `compose` — never set manually. @internal */
  hostState?: Record<string, any>;
}

/**
 * The binding contract of a Fleet: Durable Object class declarations plus
 * environment variables (wrangler `vars`).
 */
export interface FleetBindingContract {
  env?: Record<string, any>;
  durableObjects?: FleetDurableObjectBinding[];
}

export interface Fleet extends Resource<
  FleetTypeId,
  FleetProps,
  {
    /** Physical fleet name (the wrangler project name). */
    fleetName: string;
    /** The HTTP endpoint VPC-attached callers reach the fleet on. */
    fleetUrl: string;
    /** The fleet auth secret checked by the RPC gateway. */
    fleetSecret: Redacted.Redacted<string>;
    /** The S3-compatible bucket backing the fleet. */
    bucket: FleetBucket;
    /** The {@link FleetHost} kind running the nodes. */
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
  FleetBindingContract,
  Providers
> {}

export const isFleet = <T>(value: T): value is T & Fleet =>
  isResourceOfType(value, FleetTypeId);

/** Services available to a fleet impl's init effect. */
export type FleetServices = Fleet | WorkerEnvironment;

/** The impl shape of a fleet: an optional user `fetch` handler. */
export type FleetShape = Main<FleetServices>;

/**
 * Compose the fleet's platform-specific children (bucket, network, node
 * compute, secret) through the registered {@link FleetHost} and rewrite the
 * props with the connection material. A no-op at runtime.
 */
const transformFleetProps = (
  id: string,
  props: FleetProps,
): Effect.Effect<FleetProps, unknown, any> =>
  Effect.gen(function* () {
    // Composition is a plan/deploy concern — never runs inside bundles.
    if (globalThis.__ALCHEMY_RUNTIME__) {
      return props;
    }
    const { kind, host } = yield* resolveFleetHost(props.host?.kind);
    const composed = yield* host.compose({ id, props });
    return {
      ...props,
      hostKind: kind,
      bucket: composed.bucket,
      fleetUrl: composed.fleetUrl,
      fleetSecret: composed.fleetSecret,
      hostState: composed.hostState,
    } as FleetProps;
  });

export const Fleet: Platform<
  Fleet,
  FleetServices,
  FleetShape,
  FleetRuntimeContext
> = Platform(FleetTypeId, {
  createRuntimeContext: makeFleetRuntimeContext,
  transformProps: transformFleetProps,
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

export const FleetProvider = () =>
  Provider.effect(
    Fleet,
    Effect.gen(function* () {
      const stack = yield* Stack;

      const collectBindings = (
        bindings: ResourceBinding<FleetBindingContract>[] | undefined,
      ) => {
        const active = (bindings ?? []).filter(
          (
            binding: ResourceBinding<FleetBindingContract> & {
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

      const buildBundle = (id: string, news: FleetProps) =>
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

      const fleetName = (id: string) =>
        `${stack.name}-${stack.stage}-${id}`.toLowerCase();

      return {
        stables: ["fleetName", "bucket", "hostKind"],

        read: ({ output }: { output: Fleet["Attributes"] | undefined }) =>
          Effect.succeed(output),

        diff: ({
          id,
          news,
          output,
        }: {
          id: string;
          news: any;
          output: Fleet["Attributes"] | undefined;
        }) =>
          Effect.gen(function* () {
            // Surface source drift that prop comparison can't see: build
            // (cached — shared with reconcile in the same run) and compare
            // content hashes. Skip when `main` is still an unresolved Input.
            if (output === undefined || typeof news?.main !== "string") {
              return undefined;
            }
            const bundle = yield* buildBundle(id, news as FleetProps);
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
          news: FleetProps;
          olds: FleetProps | undefined;
          output: Fleet["Attributes"] | undefined;
          session: { note: (message: string) => Effect.Effect<void> };
          bindings: ResourceBinding<FleetBindingContract>[];
        }) {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          if (news.main === undefined) {
            return yield* Effect.die(
              new Error(`Celld.Fleet '${id}' requires a 'main' entry module.`),
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
                `Celld.Fleet '${id}' has no composed host state — was the ` +
                  "fleet host's transformProps skipped?",
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

          yield* session.note("bundling fleet worker");
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
              name: fleetName(id),
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
            fleetName: fleetName(id),
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

        // The deployment object lives in the host-composed bucket, which the
        // host tears down with the rest of the fleet's children — nothing to
        // delete here.
        delete: () => Effect.void,
      };
    }),
  );
