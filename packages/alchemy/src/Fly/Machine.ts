import { Services } from "@distilled.cloud/fly-io";
import type {
  FlyMachineConfig,
  FlyMachineGuest,
  FlyMachineInit,
  FlyMachineMount,
  FlyMachineRestart,
  FlyMachineService,
  ImageRef as FlyImageRef,
  Machine as FlyMachine,
} from "@distilled.cloud/fly-io/machines";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource, type ResourceBinding } from "../Resource.ts";
import { App, listOwnedApps } from "./App.ts";
import {
  alchemyMetadataKeys,
  createFlyResourceName,
  createMachineMetadata,
  diffMachineMetadata,
  isAlchemyOwnedMetadata,
  sanitizeFlyAppName,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";
import type { Volume } from "./Volume.ts";

const DEFAULT_REGION = "iad";
const DEFAULT_CPU_KIND = "shared";
const DEFAULT_CPUS = 1;
const DEFAULT_MEMORY_MB = 256;
const WAIT_TIMEOUT_SECONDS = 8;

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* App(...)` and `App(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export interface MachineGuest {
  /**
   * CPU kind (`shared`, `performance`, `shared-cpu-1x`, …).
   *
   * @default "shared"
   */
  cpuKind?: string;
  /**
   * Number of CPUs.
   *
   * @default 1
   */
  cpus?: number;
  /**
   * Memory in MB.
   *
   * @default 256
   */
  memoryMb?: number;
  /** GPU kind, if this Machine should have a GPU. */
  gpuKind?: string;
  /** Number of GPUs. */
  gpus?: number;
}

export interface MachineInit {
  /** Process command. */
  cmd?: string[];
  /** Container entrypoint. */
  entrypoint?: string[];
  /** Exec form override. */
  exec?: string[];
  /** Swap size in MB. */
  swapSizeMb?: number;
  /** Allocate a TTY. */
  tty?: boolean;
}

export interface MachineRestart {
  /**
   * Restart policy (`no`, `always`, `on-failure`, `spot-price`).
   */
  policy?: "no" | "always" | "on-failure" | "spot-price";
  /** Max restarts when `policy` is `on-failure`. */
  maxRetries?: number;
}

export interface MachinePort {
  /** Published proxy port. */
  port?: number;
  /** Fly handlers (`http`, `tls`, `pg_tls`, …). */
  handlers?: string[];
  /** Redirect HTTP to HTTPS on this port. */
  forceHttps?: boolean;
  /** Inclusive start of a published port range. */
  startPort?: number;
  /** Inclusive end of a published port range. */
  endPort?: number;
}

export interface MachineService {
  /**
   * Proxy protocol (`tcp` or `udp`).
   */
  protocol?: string;
  /** Port the process listens on inside the Machine. */
  internalPort?: number;
  /** Published Fly proxy ports. */
  ports?: MachinePort[];
  /** Start this Machine when a request arrives. */
  autostart?: boolean;
  /**
   * Stop or suspend this Machine when idle.
   */
  autostop?: "off" | "stop" | "suspend" | boolean;
  /** Minimum Machines to keep running for this service. */
  minMachinesRunning?: number;
}

export interface MachineMount {
  /**
   * Volume to attach. Accepts a `Fly.Volume` or `{ volumeId }` stub.
   */
  volume: Ref<Volume | { volumeId: string }>;
  /** Path inside the Machine to mount the Volume. */
  path: string;
}

export interface MachineProps {
  /**
   * Parent Fly App. Changing it replaces the Machine.
   */
  app: Ref<App>;
  /**
   * Machine name. Unique per App. If omitted, a unique name is generated
   * from the stack, stage and logical ID. Changing it replaces the Machine.
   */
  name?: string;
  /**
   * Region to start the Machine in (`iad`, `ewr`, `ord`, …). Changing it
   * replaces the Machine.
   *
   * @default "iad"
   */
  region?: string;
  /**
   * Docker image reference. Updated in place via `machinesUpdate`.
   */
  image: string;
  /**
   * Guest size. Defaults to shared-cpu-1x 256 MB.
   */
  guest?: MachineGuest;
  /**
   * Environment variables. Merged with binding `env`.
   */
  env?: Record<string, string>;
  /**
   * Fly proxy services (HTTP/TCP ports).
   */
  services?: MachineService[];
  /**
   * Volumes to attach. Also collected from `MountVolume` bindings.
   */
  mounts?: MachineMount[];
  /**
   * Init overrides (`cmd`, `entrypoint`, `exec`, swap, TTY).
   */
  init?: MachineInit;
  /**
   * User metadata. Alchemy ownership keys (`alchemy.stack` /
   * `alchemy.stage` / `alchemy.id` / `alchemy.type`) are always merged.
   */
  metadata?: Record<string, string>;
  /**
   * Destroy the Machine when its main process exits.
   *
   * @default false
   */
  autoDestroy?: boolean;
  /**
   * Restart policy after the main process exits.
   */
  restart?: MachineRestart;
  /**
   * Create or update without launching the Machine.
   *
   * @default false
   */
  skipLaunch?: boolean;
  /**
   * Minimum app-secrets version the Machine must see.
   */
  minSecretsVersion?: number;
}

export type MachineImageRef = {
  registry?: string;
  repository?: string;
  tag?: string;
  digest?: string;
};

export type Machine = Resource<
  "Fly.Machine",
  MachineProps,
  {
    /** Parent Fly App name. */
    appName: string;
    /** Fly Machine id. */
    machineId: string;
    /** Machine name (unique per App). */
    name: string;
    /** Region the Machine is running in. */
    region: string;
    /** Observed state (`created`, `started`, `stopped`, …). */
    state: string;
    /** Fly instance / version id, if the API returned one. */
    instanceId: string | undefined;
    /** Internal 6PN address. */
    privateIp: string | undefined;
    /** Parsed image reference from Fly. */
    imageRef: MachineImageRef | undefined;
    /** Observed guest size. */
    guest: MachineGuest | undefined;
    /**
     * Public `https://{appName}.fly.dev` URL when this Machine publishes
     * a proxy service. `undefined` when no services are configured.
     */
    url: string | undefined;
  },
  {
    /** Environment variables collected from bindings. */
    env?: Record<string, any>;
    /**
     * Volumes to attach. Collected from `Fly.MountVolume` when the
     * Machine is the bind host.
     */
    mounts?: Array<{ volume: string; path: string }>;
  },
  Providers
>;

/**
 * A raw Fly.io Firecracker Machine — a VM that runs a public Docker image
 * under an App. Image, guest, env, services, mounts, metadata and restart
 * update in place via `machinesUpdate`. Name, region and App replace.
 *
 * Ownership is stamped on `config.metadata` (`alchemy.stack` /
 * `alchemy.stage` / `alchemy.id` / `alchemy.type=Fly.Machine`). Fly Apps
 * have no labels.
 *
 * @resource
 * @see https://fly.io/docs/machines/api/machines-resource/
 *
 * @section Creating a Machine
 * @example Nginx in iad
 * ```typescript
 * const site = yield* Fly.App("Site");
 * const web = yield* Fly.Machine("Web", {
 *   app: site,
 *   region: "iad",
 *   image: "nginx:alpine",
 *   guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
 * });
 * ```
 *
 * @example Machine with env and HTTP service
 * ```typescript
 * const web = yield* Fly.Machine("Web", {
 *   app: site,
 *   image: "nginx:alpine",
 *   env: { NGINX_ENTRYPOINT_QUIET_LOGS: "1" },
 *   services: [
 *     {
 *       protocol: "tcp",
 *       internalPort: 80,
 *       ports: [{ port: 80, handlers: ["http"] }],
 *     },
 *   ],
 * });
 * ```
 *
 * @section Attaching a Volume
 * @example Mount a Volume
 * ```typescript
 * const data = yield* Fly.Volume("Data", { app: site, sizeGb: 1 });
 * const web = yield* Fly.Machine("Web", {
 *   app: site,
 *   image: "nginx:alpine",
 *   mounts: [{ volume: data, path: "/data" }],
 * });
 * ```
 */
export const Machine = Resource<Machine>("Fly.Machine");

export class MachineNotCreated extends Data.TaggedError(
  "Fly.MachineNotCreated",
)<{
  name: string;
  appName: string;
}> {}

export class MachineAppNotResolved extends Data.TaggedError(
  "Fly.MachineAppNotResolved",
)<{
  message: string;
}> {}

type MachineBinding = Machine["Binding"];

const waitBackoff = Schedule.exponential("500 millis");

const appNameOf = (value: unknown): string | undefined => {
  if (value == null || typeof value !== "object") return undefined;
  const name = (value as { appName?: unknown }).appName;
  return typeof name === "string" && name.length > 0 ? name : undefined;
};

const volumeIdOf = (value: unknown): string | undefined => {
  if (value == null || typeof value !== "object") return undefined;
  const id = (value as { volumeId?: unknown }).volumeId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
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

const gone = (machine: FlyMachine | undefined) =>
  machine === undefined || machine.state === "destroyed";

const toImageRef = (
  ref: FlyImageRef | undefined,
): MachineImageRef | undefined => {
  if (ref === undefined) return undefined;
  const imageRef: MachineImageRef = {
    registry: ref.registry,
    repository: ref.repository,
    tag: ref.tag,
    digest: ref.digest,
  };
  return imageRef.registry === undefined &&
    imageRef.repository === undefined &&
    imageRef.tag === undefined &&
    imageRef.digest === undefined
    ? undefined
    : imageRef;
};

const toGuestAttrs = (
  guest: FlyMachineGuest | undefined,
): MachineGuest | undefined => {
  if (guest === undefined) return undefined;
  return {
    cpuKind: guest.cpu_kind,
    cpus: guest.cpus,
    memoryMb: guest.memory_mb,
    gpuKind: guest.gpu_kind,
    gpus: guest.gpus,
  };
};

const hasPublishedService = (services: FlyMachineService[] | undefined) =>
  (services ?? []).some((service) =>
    (service.ports ?? []).some(
      (port) => port.port !== undefined || port.start_port !== undefined,
    ),
  );

const toAttrs = (
  machine: FlyMachine,
  appName: string,
): Machine["Attributes"] => {
  const name = machine.name ?? "";
  return {
    appName,
    machineId: machine.id ?? "",
    name,
    region: machine.region ?? "",
    state: machine.state ?? "",
    instanceId: machine.instance_id,
    privateIp: machine.private_ip,
    imageRef: toImageRef(machine.image_ref),
    guest: toGuestAttrs(machine.config?.guest),
    url: hasPublishedService(machine.config?.services)
      ? `https://${appName}.fly.dev`
      : undefined,
  };
};

const getById = (appName: string, machineId: string) =>
  Services.machines
    .machinesShow({ app_name: appName, machine_id: machineId })
    .pipe(
      Effect.map((machine) => (gone(machine) ? undefined : machine)),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

const listByApp = (appName: string) =>
  Services.machines.machinesList({ app_name: appName }).pipe(
    Effect.map((machines) => machines.filter((machine) => !gone(machine))),
    Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed([])),
  );

const getByName = (appName: string, name: string) =>
  listByApp(appName).pipe(
    Effect.map((machines) => machines.find((machine) => machine.name === name)),
  );

const isOwnedMachine = (machine: FlyMachine) => {
  const metadata = compactRecord(machine.config?.metadata);
  return (
    isAlchemyOwnedMetadata(metadata) &&
    metadata[alchemyMetadataKeys.type] === "Fly.Machine"
  );
};

const waitStarted = (appName: string, machineId: string) =>
  Services.machines
    .machinesWait({
      app_name: appName,
      machine_id: machineId,
      state: "started",
      timeout: WAIT_TIMEOUT_SECONDS,
    })
    .pipe(
      Effect.retry({
        times: 6,
        schedule: waitBackoff,
        while: (e) => e._tag === "GatewayTimeout",
      }),
    );

const waitDestroyed = (appName: string, machineId: string) =>
  Services.machines
    .machinesWait({
      app_name: appName,
      machine_id: machineId,
      state: "destroyed",
      timeout: WAIT_TIMEOUT_SECONDS,
    })
    .pipe(
      Effect.as(undefined),
      Effect.catchTag("NotFound", () => Effect.void),
      Effect.retry({
        times: 6,
        schedule: waitBackoff,
        while: (e) => e._tag === "GatewayTimeout",
      }),
    );

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

const toFlyInit = (init: MachineInit): FlyMachineInit => ({
  cmd: init.cmd,
  entrypoint: init.entrypoint,
  exec: init.exec,
  swap_size_mb: init.swapSizeMb,
  tty: init.tty,
});

const toFlyRestart = (restart: MachineRestart): FlyMachineRestart => ({
  policy: restart.policy,
  max_retries: restart.maxRetries,
});

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

const mergeBindings = (
  bindings: readonly ResourceBinding<MachineBinding>[],
) => {
  const env: Record<string, any> = {};
  const mounts: Array<{ volume: string; path: string }> = [];
  for (const binding of bindings) {
    Object.assign(env, binding.data?.env);
    if (binding.data?.mounts) mounts.push(...binding.data.mounts);
  }
  return { env, mounts };
};

const desiredMounts = (
  props: MachineProps,
  bindingMounts: Array<{ volume: string; path: string }>,
): FlyMachineMount[] => {
  const fromProps = (props.mounts ?? []).flatMap((mount) => {
    const volume = volumeIdOf(mount.volume);
    return volume === undefined ? [] : [{ volume, path: mount.path }];
  });
  const seen = new Set<string>();
  const mounts: FlyMachineMount[] = [];
  for (const mount of [...fromProps, ...bindingMounts]) {
    const key = `${mount.volume}:${mount.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mounts.push(mount);
  }
  return mounts;
};

const desiredEnv = (
  props: MachineProps,
  bindingEnv: Record<string, any>,
): Record<string, string> => ({
  ...toEnv(props.env),
  ...toEnv(bindingEnv),
});

const desiredMetadata = (
  props: MachineProps,
  alchemy: Record<string, string>,
): Record<string, string> => ({
  ...(props.metadata ?? {}),
  ...alchemy,
});

const buildConfig = (input: {
  image: string;
  guest: FlyMachineGuest;
  env: Record<string, string>;
  services: FlyMachineService[] | undefined;
  mounts: FlyMachineMount[];
  metadata: Record<string, string>;
  restart: FlyMachineRestart | undefined;
  autoDestroy: boolean | undefined;
  init: FlyMachineInit | undefined;
}): FlyMachineConfig => ({
  image: input.image,
  guest: input.guest,
  env: Object.keys(input.env).length > 0 ? input.env : undefined,
  services:
    input.services !== undefined && input.services.length > 0
      ? input.services
      : undefined,
  mounts: input.mounts.length > 0 ? input.mounts : undefined,
  metadata: input.metadata,
  restart: input.restart,
  auto_destroy: input.autoDestroy,
  init: input.init,
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
  desired: FlyMachineService[] | undefined,
) => deepEqual(observed ?? [], desired ?? [], { stripNullish: true });

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

const sameRestart = (
  observed: FlyMachineRestart | undefined,
  desired: FlyMachineRestart | undefined,
) =>
  deepEqual(
    {
      policy: observed?.policy,
      max_retries: observed?.max_retries,
    },
    {
      policy: desired?.policy,
      max_retries: desired?.max_retries,
    },
    { stripNullish: true },
  );

const sameInit = (
  observed: FlyMachineInit | undefined,
  desired: FlyMachineInit | undefined,
) => deepEqual(observed ?? {}, desired ?? {}, { stripNullish: true });

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
    services: FlyMachineService[] | undefined;
    mounts: FlyMachineMount[];
    metadata: Record<string, string>;
    restart: FlyMachineRestart | undefined;
    autoDestroy: boolean | undefined;
    init: FlyMachineInit | undefined;
  },
) => {
  const config = machine.config;
  return (
    !sameImage(machine, desired.image) ||
    !sameGuest(config?.guest, desired.guest) ||
    !sameEnv(config?.env, desired.env) ||
    !sameServices(config?.services, desired.services) ||
    !sameMounts(config?.mounts, desired.mounts) ||
    metadataChanged(config?.metadata, desired.metadata) ||
    !sameRestart(config?.restart, desired.restart) ||
    (desired.autoDestroy ?? false) !== (config?.auto_destroy ?? false) ||
    !sameInit(config?.init, desired.init)
  );
};

const ensureStarted = Effect.fn(function* (
  appName: string,
  machine: FlyMachine,
  skipLaunch: boolean,
) {
  const machineId = machine.id;
  if (machineId === undefined || skipLaunch) return machine;
  const state = machine.state;
  if (state !== "started" && state !== "starting") {
    yield* Services.machines
      .machinesStart({
        app_name: appName,
        machine_id: machineId,
      })
      .pipe(Effect.catchTag(["NotFound", "Conflict"], () => Effect.void));
  }
  yield* waitStarted(appName, machineId);
  return (yield* getById(appName, machineId)) ?? machine;
});

export const MachineProvider = () =>
  Provider.succeed(Machine, {
    stables: ["machineId", "name", "region", "appName"],
    nuke: { dependsOn: ["Fly.App"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const desiredAppName = appNameOf(news.app);
      const appChanged =
        desiredAppName !== undefined && desiredAppName !== output.appName;
      const desiredName =
        news.name !== undefined ? sanitizeFlyAppName(news.name) : output.name;
      const nameChanged = desiredName !== output.name;
      const desiredRegion = news.region ?? DEFAULT_REGION;
      const regionChanged = desiredRegion !== output.region;
      if (appChanged || nameChanged || regionChanged) {
        return {
          action: "replace" as const,
          // Name is unique per App — same name in a new region cannot coexist.
          deleteFirst: nameChanged === false && appChanged === false,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const appName = appNameOf(olds?.app) ?? output?.appName;
      const name = yield* resolveMachineName(id, olds?.name, output?.name);
      const found =
        (output?.machineId !== undefined && appName !== undefined
          ? yield* getById(output.appName || appName, output.machineId)
          : undefined) ??
        (appName !== undefined ? yield* getByName(appName, name) : undefined);
      if (found === undefined || appName === undefined) return undefined;
      const attrs = toAttrs(
        found,
        appNameOf(olds?.app) ?? output?.appName ?? appName,
      );
      if (output !== undefined) return attrs;
      return isOwnedMachine(found) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const apps = yield* listOwnedApps();
      const groups = yield* Effect.forEach(
        apps,
        (app) =>
          listByApp(app.appName).pipe(
            Effect.map((machines) =>
              machines
                .filter(isOwnedMachine)
                .map((machine) => toAttrs(machine, app.appName)),
            ),
          ),
        { concurrency: 8 },
      );
      return groups.flat();
    }),

    reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
      const props = news;
      const appName = appNameOf(props.app) ?? output?.appName;
      if (appName === undefined) {
        return yield* new MachineAppNotResolved({
          message: "Fly.Machine requires a resolved App with appName.",
        });
      }
      const name = yield* resolveMachineName(id, props.name, output?.name);
      const region = props.region ?? output?.region ?? DEFAULT_REGION;
      const skipLaunch = props.skipLaunch === true;
      const alchemy = yield* createMachineMetadata(id, "Fly.Machine");
      const bound = mergeBindings(bindings ?? []);
      const mounts = desiredMounts(props, bound.mounts);
      const env = desiredEnv(props, bound.env);
      const metadata = desiredMetadata(props, alchemy);
      const guest = toFlyGuest(props.guest);
      const services = props.services?.map(toFlyService);
      const restart = props.restart ? toFlyRestart(props.restart) : undefined;
      const init = props.init ? toFlyInit(props.init) : undefined;
      const config = buildConfig({
        image: props.image,
        guest,
        env,
        services,
        mounts,
        metadata,
        restart,
        autoDestroy: props.autoDestroy,
        init,
      });

      // Observe by cached id, then desired name. A create-first replacement
      // still has the old generation live under a different name.
      let current =
        output?.machineId !== undefined
          ? yield* getById(output.appName || appName, output.machineId)
          : undefined;
      if (current === undefined) {
        current = yield* getByName(appName, name);
      }

      if (current === undefined) {
        const created = yield* Services.machines
          .machinesCreate({
            app_name: appName,
            name,
            region,
            config,
            skip_launch: skipLaunch ? true : undefined,
            min_secrets_version: props.minSecretsVersion,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = created ?? (yield* getByName(appName, name));
        if (current === undefined || current.id === undefined) {
          return yield* new MachineNotCreated({ name, appName });
        }
      }

      const machineId = current.id;
      if (machineId === undefined || machineId.length === 0) {
        return yield* new MachineNotCreated({ name, appName });
      }

      if (
        configDrifted(current, {
          image: props.image,
          guest,
          env,
          services,
          mounts,
          metadata,
          restart,
          autoDestroy: props.autoDestroy,
          init,
        })
      ) {
        const updated = yield* Services.machines
          .machinesUpdate({
            app_name: appName,
            machine_id: machineId,
            config,
            skip_launch: skipLaunch ? true : undefined,
            min_secrets_version: props.minSecretsVersion,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (updated !== undefined) current = updated;
      }

      current = yield* ensureStarted(appName, current, skipLaunch);
      const fresh = yield* getById(appName, current.id ?? machineId);
      return toAttrs(fresh ?? current, appName);
    }),

    delete: Effect.fn(function* ({ output }) {
      const appName = output.appName;
      const machineId = output.machineId;
      if (appName.length === 0 || machineId.length === 0) return;
      yield* Services.machines
        .machinesDelete({
          app_name: appName,
          machine_id: machineId,
          force: true,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (e) => e._tag === "Conflict",
            times: 6,
            schedule: waitBackoff,
          }),
        );
      yield* waitDestroyed(appName, machineId);
    }),
  });
