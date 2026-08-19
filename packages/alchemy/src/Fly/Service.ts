import type {
  FlyMachineConfig,
  FlyMachineGuest,
  FlyMachineMount,
  FlyMachineService,
  Machine as FlyMachine,
} from "@distilled.cloud/fly-io/machines";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AlchemyContext } from "../AlchemyContext.ts";
import * as Bundle from "../Bundle/Bundle.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import { DockerLive, Docker } from "../Docker/Docker.ts";
import { Platform, type Main, type PlatformProps } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import type { Resource } from "../Resource.ts";
import type { ServerHost } from "../Server/Process.ts";
import { Stack } from "../Stack.ts";
import { App } from "./App.ts";
import type {
  MachineGuest,
  MachineImageRef,
  MachineService,
} from "./Machine.ts";
import {
  createFlyResourceName,
  diffMachineMetadata,
  sanitizeFlyAppName,
} from "./Metadata.ts";
import type { MountedDisk, ServiceBinding } from "./MountVolume.ts";
import type { Providers } from "./Providers.ts";
import {
  collectBindingState,
  createFlyHostedSupport,
  createFlyHostRuntimeContext,
  defaultHttpServices,
  DEFAULT_PORT,
  type FlyHostRuntimeContext,
} from "./hosted.ts";
import {
  deleteReplicaSet,
  listReplicaSets,
  observeReplicaSet,
  reconcileReplicas,
  resolveCount,
  volumeIdsOf,
  type Replica,
  type ReplicaSet,
} from "./replicas.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* App(...)` and `App(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

const DEFAULT_REGION = "iad";
const DEFAULT_CPU_KIND = "shared";
const DEFAULT_CPUS = 1;
const DEFAULT_MEMORY_MB = 256;

export interface ServiceProps extends PlatformProps {
  /**
   * Parent Fly App. Accepts a `Fly.App` or an Effect that produces one
   * (module-scope `const Site = Fly.App("Site")` is valid). Changing the
   * App replaces the Service.
   */
  app: Ref<App>;
  /**
   * Module entrypoint bundled with rolldown and baked into a Docker
   * image pushed to `registry.fly.io`. Typically `import.meta.url`.
   * A content-hash change updates the Machine in place.
   */
  main: string;
  /**
   * Region to start the Machine in (`iad`, `ewr`, `ord`, …). Changing
   * it replaces the Service.
   *
   * @default "iad"
   */
  region?: string;
  /**
   * Number of Machines to keep running. Fly's proxy load-balances
   * `{app}.fly.dev` across them. Each replica gets its own Volume
   * from every `MountVolume` binding.
   *
   * @default 1
   */
  count?: number;
  /**
   * Guest size. Defaults to shared-cpu-1x 256 MB.
   */
  guest?: MachineGuest;
  /**
   * Port the hosted HTTP server listens on. Written to `PORT` and used
   * as the Fly proxy `internal_port`.
   *
   * @default 3000
   */
  port?: number;
  /**
   * Named export to load from `main`.
   *
   * @default "default"
   */
  handler?: string;
  /**
   * Additional environment variables for the hosted process. Merged
   * after binding-injected `env`.
   */
  env?: Record<string, any>;
  /**
   * Bundler configuration for `main`: rolldown `input`/`output`
   * overrides plus pure-annotation options (`pure`).
   */
  build?: Bundle.BundleConfig;
  /**
   * Environment image used as the generated Dockerfile's `FROM`. Must
   * be able to run the bun runtime.
   *
   * @default "oven/bun:1"
   */
  image?: string;
  /**
   * Fly proxy services. Defaults to HTTP 80 + HTTPS 443 → {@link port}.
   */
  services?: MachineService[];
  /**
   * Machine name. Unique per App. If omitted, a unique name is generated
   * from the stack, stage and logical ID. Changing it replaces the Service.
   */
  name?: string;
}

export type Service = Resource<
  "Fly.Service",
  ServiceProps,
  {
    /** Parent Fly App name. */
    appName: string;
    /** Fly Machine id of replica 0. */
    machineId: string;
    /** Fly Machine ids of every replica. */
    machineIds: string[];
    /** Machine name of replica 0 (unique per App). */
    name: string;
    /** Region the Machines are running in. */
    region: string;
    /** Observed state of replica 0 (`created`, `started`, `stopped`, …). */
    state: string;
    /**
     * Public `https://{appName}.fly.dev` URL when a proxy service is
     * configured.
     */
    url: string | undefined;
    /** Parsed image reference from Fly. */
    imageRef: MachineImageRef | undefined;
    /** Number of Machines in the replica set. */
    count: number;
    /** Disks mounted on replica 0. */
    mounts: MountedDisk[];
    /** Every replica in the set. */
    replicas: Replica[];
    /** Content hash of the bundled program's image. */
    code: {
      hash: string;
    };
  },
  ServiceBinding,
  Providers
>;

export const isService = (value: unknown): value is Service =>
  typeof value === "object" &&
  value !== null &&
  (value as { Type?: string }).Type === "Fly.Service";

export type ServiceServices = ServerHost;

export type ServiceShape = Main<ServiceServices>;

export type ServiceRuntimeContext = FlyHostRuntimeContext;

/**
 * An Effect program hosted as a Fly.io Machine under an App.
 *
 * N Services share one App; each Service is its own replica set of
 * Machines (not systemd-on-a-box). `count` is the pool size — Fly's
 * proxy load-balances published services across them. `main` is bundled
 * with rolldown, baked into a Docker image, and pushed to
 * `registry.fly.io/{app}:{id}-{hash}`. Bind `Fly.MountVolume({ path,
 * sizeGb })` inside the impl to attach a per-replica disk.
 *
 * @resource
 * @see https://fly.io/docs/machines/api/machines-resource/
 *
 * @section Hosting a Service
 * @example HTTP server on an App
 * ```typescript
 * const Site = Fly.App("Site");
 *
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, region: "iad" },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.json({ ok: true })),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * @section Scaling
 * @example Three replicas behind the Fly proxy
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, region: "iad", count: 3, port: 3000 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.json({ ok: true })),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * @section Volumes
 * @example Mount a per-replica disk
 * ```typescript
 * const disk = yield* Fly.MountVolume({ path: "/data", sizeGb: 1 });
 * // write/read files under disk.path inside the hosted process
 * ```
 */
export const Service: Platform<
  Service,
  ServiceServices,
  ServiceShape,
  ServiceRuntimeContext
> = Platform("Fly.Service", {
  createRuntimeContext: createFlyHostRuntimeContext("Fly.Service"),
  // `{ app: Site }` at module scope is an Effect. Yield it here so the
  // App is registered and `news.app` is resolved attributes at
  // reconcile (same DX as `yield* App(...)` inside Effect.gen).
  transformProps: (_id, props) =>
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) return props;
      const app = Effect.isEffect(props.app)
        ? yield* props.app as Effect.Effect<App, never, Providers>
        : props.app;
      return { ...props, app };
    }),
});

export class ServiceNotCreated extends Data.TaggedError(
  "Fly.ServiceNotCreated",
)<{
  name: string;
  appName: string;
}> {}

export class ServiceAppNotResolved extends Data.TaggedError(
  "Fly.ServiceAppNotResolved",
)<{
  message: string;
}> {}

const appNameOf = (value: unknown): string | undefined => {
  if (value == null || typeof value !== "object") return undefined;
  const name = (value as { appName?: unknown }).appName;
  return typeof name === "string" && name.length > 0 ? name : undefined;
};

const compactRecord = (
  record: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record ?? {}).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  );

const toEnv = (env: Record<string, any> | undefined): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env ?? {}).flatMap(([key, value]) =>
      value === undefined || value === null ? [] : [[key, String(value)]],
    ),
  );

const resolveMachineName = (
  id: string,
  name: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined) return sanitizeFlyAppName(name);
    if (existing !== undefined) return existing;
    return yield* createFlyResourceName(id);
  });

const toFlyGuest = (guest: MachineGuest | undefined): FlyMachineGuest => {
  const fly: FlyMachineGuest = {
    cpu_kind: guest?.cpuKind ?? DEFAULT_CPU_KIND,
    cpus: guest?.cpus ?? DEFAULT_CPUS,
    memory_mb: guest?.memoryMb ?? DEFAULT_MEMORY_MB,
  };
  if (guest?.gpuKind !== undefined) fly.gpu_kind = guest.gpuKind;
  if (guest?.gpus !== undefined) fly.gpus = guest.gpus;
  return fly;
};

const toFlyService = (service: MachineService): FlyMachineService => ({
  protocol: service.protocol,
  internal_port: service.internalPort,
  autostart: service.autostart,
  autostop:
    typeof service.autostop === "boolean"
      ? service.autostop
        ? "stop"
        : "off"
      : service.autostop,
  min_machines_running: service.minMachinesRunning,
  ports: service.ports?.map((port) => ({
    port: port.port,
    handlers: port.handlers,
    force_https: port.forceHttps,
    start_port: port.startPort,
    end_port: port.endPort,
  })),
});

const desiredEnv = (
  props: ServiceProps,
  bindingEnv: Record<string, any>,
  alchemyEnv: Record<string, string>,
  port: number,
): Record<string, string> => ({
  ...toEnv(bindingEnv),
  ...alchemyEnv,
  PORT: String(port),
  ...toEnv(props.env),
});

const buildConfig = (input: {
  image: string;
  guest: FlyMachineGuest;
  env: Record<string, string>;
  services: FlyMachineService[];
  mounts: FlyMachineMount[];
  metadata: Record<string, string>;
}): FlyMachineConfig => ({
  image: input.image,
  guest: input.guest,
  env: Object.keys(input.env).length > 0 ? input.env : undefined,
  services: input.services.length > 0 ? input.services : undefined,
  mounts: input.mounts.length > 0 ? input.mounts : undefined,
  metadata: input.metadata,
});

const sameImage = (machine: FlyMachine, image: string) => {
  const configImage = machine.config?.image;
  if (configImage === image) return true;
  const ref = machine.image_ref;
  const colon = image.lastIndexOf(":");
  const slash = image.lastIndexOf("/");
  const split = colon > slash ? colon : -1;
  const repo = split === -1 ? image : image.slice(0, split);
  const tag = split === -1 ? "latest" : image.slice(split + 1);
  const observedRepo = ref?.repository;
  if (observedRepo === undefined || ref?.tag !== tag) return false;
  return observedRepo === repo || observedRepo.endsWith(`/${repo}`);
};

const sameGuest = (
  observed: FlyMachineGuest | undefined,
  desired: FlyMachineGuest,
) =>
  (observed?.cpu_kind ?? DEFAULT_CPU_KIND) === desired.cpu_kind &&
  (observed?.cpus ?? DEFAULT_CPUS) === desired.cpus &&
  (observed?.memory_mb ?? DEFAULT_MEMORY_MB) === desired.memory_mb &&
  observed?.gpu_kind === desired.gpu_kind &&
  observed?.gpus === desired.gpus;

const sameEnv = (
  observed: Record<string, string | undefined> | undefined,
  desired: Record<string, string>,
) => deepEqual(compactRecord(observed), desired);

const sameServices = (
  observed: FlyMachineService[] | undefined,
  desired: FlyMachineService[],
) => deepEqual(observed ?? [], desired, { stripNullish: true });

const sameMounts = (
  observed: FlyMachineMount[] | undefined,
  desired: FlyMachineMount[],
) => {
  const key = (mount: FlyMachineMount) =>
    `${mount.volume ?? ""}:${mount.path ?? ""}`;
  const left = [...(observed ?? [])].map(key).sort();
  const right = desired.map(key).sort();
  return deepEqual(left, right);
};

const metadataChanged = (
  observed: Record<string, string | undefined> | undefined,
  desired: Record<string, string>,
) => {
  const { removed, added, updated } = diffMachineMetadata(
    compactRecord(observed),
    desired,
  );
  return (
    removed.length > 0 ||
    Object.keys(added).length > 0 ||
    Object.keys(updated).length > 0
  );
};

const configDrifted = (
  machine: FlyMachine,
  desired: {
    image: string;
    guest: FlyMachineGuest;
    env: Record<string, string>;
    services: FlyMachineService[];
    mounts: FlyMachineMount[];
    metadata: Record<string, string>;
  },
) => {
  const config = machine.config;
  return (
    !sameImage(machine, desired.image) ||
    !sameGuest(config?.guest, desired.guest) ||
    !sameEnv(config?.env, desired.env) ||
    !sameServices(config?.services, desired.services) ||
    !sameMounts(config?.mounts, desired.mounts) ||
    metadataChanged(config?.metadata, desired.metadata)
  );
};

const toAttrs = (set: ReplicaSet, codeHash: string): Service["Attributes"] => ({
  appName: set.appName,
  machineId: set.machineId,
  machineIds: set.machineIds,
  name: set.name,
  region: set.region,
  state: set.state,
  url: set.url,
  imageRef: set.imageRef,
  count: set.count,
  mounts: set.mounts,
  replicas: set.replicas,
  code: { hash: codeHash },
});

const machineIdsOf = (output: Service["Attributes"] | undefined) =>
  output?.machineIds ??
  (output?.machineId !== undefined && output.machineId.length > 0
    ? [output.machineId]
    : []);

export const ServiceProvider = () =>
  Provider.effect(
    Service,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const docker = yield* Docker;
      const { dotAlchemy } = yield* AlchemyContext;
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
      const hosted = createFlyHostedSupport({
        stackName: stack.name,
        stage: stack.stage,
        virtualEntryPlugin,
        docker,
        dotAlchemy,
      });

      return Service.Provider.of({
        stables: ["machineId", "name", "region", "appName"],
        nuke: { dependsOn: ["Fly.App"] },

        diff: Effect.fn(function* ({ id, news, output }) {
          if (news === undefined || !isResolved(news)) return undefined;
          if (output === undefined) return undefined;
          const desiredAppName = appNameOf(news.app);
          const appChanged =
            desiredAppName !== undefined && desiredAppName !== output.appName;
          const desiredName =
            news.name !== undefined
              ? sanitizeFlyAppName(news.name)
              : output.name;
          const nameChanged = desiredName !== output.name;
          const desiredRegion = news.region ?? DEFAULT_REGION;
          const regionChanged = desiredRegion !== output.region;
          if (appChanged || nameChanged || regionChanged) {
            return {
              action: "replace" as const,
              deleteFirst: nameChanged === false && appChanged === false,
            };
          }
          const hash = yield* hosted.hash(news);
          if (hash !== output.code.hash) {
            return { action: "update" as const };
          }
          return undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const appName = appNameOf(olds?.app) ?? output?.appName;
          const name = yield* resolveMachineName(id, olds?.name, output?.name);
          const found = yield* observeReplicaSet({
            appName,
            id,
            type: "Fly.Service",
            machineIds: machineIdsOf(output),
            baseName: name,
          });
          if (found === undefined) return undefined;
          return toAttrs(found, output?.code.hash ?? "");
        }),

        list: Effect.fn(function* () {
          const sets = yield* listReplicaSets("Fly.Service");
          return sets.map((set) => toAttrs(set, ""));
        }),

        reconcile: Effect.fn(function* ({
          id,
          news,
          output,
          bindings,
          session,
        }) {
          const props = news;
          const appName = appNameOf(props.app) ?? output?.appName;
          if (appName === undefined) {
            return yield* new ServiceAppNotResolved({
              message: "Fly.Service requires a resolved App with appName.",
            });
          }
          const name = yield* resolveMachineName(id, props.name, output?.name);
          const region = props.region ?? output?.region ?? DEFAULT_REGION;
          const count = resolveCount(props.count);
          const port = props.port ?? DEFAULT_PORT;
          const bound = collectBindingState(bindings ?? []);
          const env = desiredEnv(props, bound.env, hosted.alchemyEnv, port);
          const guest = toFlyGuest(props.guest);
          const services =
            props.services !== undefined
              ? props.services.map(toFlyService)
              : defaultHttpServices(port, count);

          const { imageRef, codeHash } = yield* hosted.resolveImage({
            id,
            appName,
            props,
            previousHash: output?.code.hash,
            session,
          });

          const set = yield* reconcileReplicas({
            id,
            type: "Fly.Service",
            appName,
            baseName: name,
            region,
            count,
            disks: bound.mounts,
            outputMachineIds: machineIdsOf(output),
            preferVolumeIds: (output?.replicas ?? []).map((replica) =>
              replica.mounts.map((mount) => mount.volumeId),
            ),
            configDrifted: (machine, desired) =>
              configDrifted(machine, {
                image: imageRef,
                guest,
                env,
                services,
                mounts: desired.mounts,
                metadata: desired.metadata,
              }),
            buildConfig: ({ mounts, metadata }) =>
              buildConfig({
                image: imageRef,
                guest,
                env,
                services,
                mounts,
                metadata,
              }),
          }).pipe(
            Effect.catchTag("Fly.ReplicaNotCreated", (error) =>
              Effect.fail(
                new ServiceNotCreated({
                  name: error.name,
                  appName: error.appName,
                }),
              ),
            ),
          );
          return toAttrs(set, codeHash);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* deleteReplicaSet({
            appName: output.appName,
            machineIds: machineIdsOf(output),
            volumeIds: volumeIdsOf(output),
          });
        }),
      });
    }),
  ).pipe(Layer.provide(DockerLive));
