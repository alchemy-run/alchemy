import type {
  FlyMachineConfig,
  FlyMachineMount,
  FlyMachineService,
  FlyMachineServiceCheck,
  FlyStopConfig,
  ImageRef as FlyImageRef,
  Machine as FlyMachine,
  Volume as FlyVolume,
} from "@distilled.cloud/fly-io/machines";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Retry from "@distilled.cloud/fly-io/Retry";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { deepEqual } from "../Diff.ts";
import {
  validateDeployment,
  type DeploymentPolicy,
  type MachineCheck,
} from "./Deployment.ts";
import { reconcileBlueGreen, setRouting } from "./bluegreen.ts";
import { listOwnedApps } from "./App.ts";
import type {
  MachineGuest,
  MachineImageRef,
  MachineService,
  MachineServiceCheck,
} from "./Machine.ts";
import {
  alchemyMetadataKeys,
  createMachineMetadata,
  isAlchemyOwnedMetadata,
  sanitizeFlyAppName,
  type FlyAlchemyType,
} from "./Metadata.ts";
import type { DiskSpec, MountedDisk } from "./MountVolume.ts";
import {
  deleteVolume,
  ensureVolumeGroup,
  getVolumeById,
  volumeGroupName,
} from "./Volume.ts";

const WAIT_TIMEOUT_SECONDS = 8;
const waitBackoff = Schedule.exponential("500 millis");
const SERVICE_CHECK_NAME_PREFIX = "servicecheck-";

export class ReplicaNotCreated extends Data.TaggedError(
  "Fly.ReplicaNotCreated",
)<{
  name: string;
  appName: string;
}> {}

export class ReplicaChecksNotPassing extends Data.TaggedError(
  "Fly.ReplicaChecksNotPassing",
)<{
  appName: string;
  machineId: string;
  checks: ReadonlyArray<{
    name: string | undefined;
    status: string | undefined;
    output: string | undefined;
  }>;
}> {
  get message() {
    const checks = this.checks.map(
      (check) =>
        `${check.name ?? "unnamed"}: ${check.status ?? "unknown"}${check.output ? ` (${check.output})` : ""}`,
    );
    return `Service checks did not pass for ${this.appName}/${this.machineId}: ${checks.join("; ") || "no service check results"}`;
  }
}

export interface Replica {
  machineId: string;
  name: string;
  baseName?: string;
  region: string;
  state: string;
  instanceId: string | undefined;
  privateIp: string | undefined;
  imageRef: MachineImageRef | undefined;
  guest: MachineGuest | undefined;
  mounts: MountedDisk[];
}

export interface ReplicaSet {
  rolloutPending?: boolean;
  appName: string;
  machineId: string;
  machineIds: string[];
  name: string;
  baseName?: string;
  region: string;
  state: string;
  instanceId: string | undefined;
  privateIp: string | undefined;
  imageRef: MachineImageRef | undefined;
  guest: MachineGuest | undefined;
  url: string | undefined;
  count: number;
  mounts: MountedDisk[];
  replicas: Replica[];
}

const compactRecord = (
  record: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record ?? {}).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  );

export const gone = (machine: FlyMachine | undefined) =>
  machine === undefined || machine.state === "destroyed";

export const getMachineById = (appName: string, machineId: string) =>
  machines.getMachine({ app_name: appName, machine_id: machineId }).pipe(
    Effect.map((machine) => (gone(machine) ? undefined : machine)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

export const listMachinesByApp = (appName: string) =>
  machines.listMachines({ app_name: appName }).pipe(
    Effect.map((machines) => machines.filter((machine) => !gone(machine))),
    Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed([])),
  );

export const resolveCount = (count: number | undefined) =>
  Math.max(1, Math.floor(count ?? 1));

export const replicaMachineName = (
  base: string,
  index: number,
  count: number,
) => {
  if (count <= 1 && index === 0) return base;
  const suffix = `-${index}`;
  const room = 30 - suffix.length;
  const clipped = base.slice(0, Math.max(1, room)).replace(/-+$/g, "");
  return sanitizeFlyAppName(`${clipped}${suffix}`);
};

export const replicaIndexOf = (machine: FlyMachine): number => {
  const raw = compactRecord(machine.config?.metadata)[
    alchemyMetadataKeys.replica
  ];
  const parsed = raw === undefined ? 0 : Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const alchemyIdOf = (machine: FlyMachine): string | undefined => {
  const id = compactRecord(machine.config?.metadata)[alchemyMetadataKeys.id];
  return id !== undefined && id.length > 0 ? id : undefined;
};

export const isOwnedType = (machine: FlyMachine, type: FlyAlchemyType) => {
  const metadata = compactRecord(machine.config?.metadata);
  return (
    isAlchemyOwnedMetadata(metadata) &&
    metadata[alchemyMetadataKeys.type] === type
  );
};

export const toImageRef = (
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

export const toGuestAttrs = (
  guest:
    | {
        cpu_kind?: string;
        cpus?: number;
        memory_mb?: number;
        gpu_kind?: string;
        gpus?: number;
      }
    | undefined,
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

export const toFlyServiceCheck = (
  check: MachineServiceCheck,
): FlyMachineServiceCheck => ({
  type: check.type,
  port: check.port,
  interval: check.interval,
  timeout: check.timeout,
  grace_period: check.gracePeriod,
  method: check.method,
  path: check.path,
  protocol: check.protocol,
  headers: check.headers?.map((header) => ({
    name: header.name,
    values: header.values,
  })),
  tls_server_name: check.tlsServerName,
  tls_skip_verify: check.tlsSkipVerify,
});

export const toFlyService = (service: MachineService): FlyMachineService => ({
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
  checks: service.checks?.map(toFlyServiceCheck),
});

export const hasPublishedService = (
  services: FlyMachineService[] | undefined,
) =>
  (services ?? []).some((service) =>
    (service.ports ?? []).some(
      (port) => port.port !== undefined || port.start_port !== undefined,
    ),
  );

export const waitStarted = (appName: string, machineId: string) =>
  machines
    .waitMachine({
      app_name: appName,
      machine_id: machineId,
      state: "started",
      timeout: WAIT_TIMEOUT_SECONDS,
    })
    .pipe(
      Effect.retry({
        times: 6,
        schedule: waitBackoff,
        while: (e) =>
          e._tag === "GatewayTimeout" || e._tag === "MachineWaitTimeout",
      }),
      Effect.timeout("50 seconds"),
    );

const liveServiceChecks = (machine: FlyMachine) =>
  (machine.checks ?? []).filter((check) =>
    (check.name ?? "").startsWith(SERVICE_CHECK_NAME_PREFIX),
  );

const allServiceChecksPassing = (machine: FlyMachine, expected: number) => {
  const checks = liveServiceChecks(machine);
  return (
    checks.length >= expected &&
    checks.every((check) => check.status === "passing")
  );
};

const TRANSIENT_GET_TAGS = [
  "TooManyRequests",
  "InternalServerError",
  "BadGateway",
  "ServiceUnavailable",
  "GatewayTimeout",
] as const;

/**
 * After the Machine is started, wait until Fly reports every service
 * check as passing. No configured checks is a no-op. Empty live
 * `servicecheck-*` results keep polling — they are not success.
 * `warning` / `unknown` during grace keep polling.
 */
export const waitHealthy = Effect.fn(function* (
  appName: string,
  machine: FlyMachine,
  healthTimeoutMs = 60_000,
  config: FlyMachineConfig | undefined = machine.config,
) {
  const machineId = machine.id;
  const named = Object.keys(config?.checks ?? {});
  const expected = (config?.services ?? []).flatMap(
    (service) => service.checks ?? [],
  ).length;
  if (machineId === undefined || (expected === 0 && named.length === 0))
    return machine;

  let observed = machine;
  const notPassing = () =>
    new ReplicaChecksNotPassing({
      appName,
      machineId,
      checks: (observed.checks ?? []).map((check) => ({
        name: check.name,
        status: check.status,
        output: check.output,
      })),
    });
  const passing = yield* getMachineById(appName, machineId).pipe(
    Retry.none,
    Effect.map((current) => {
      if (current === undefined) return false;
      observed = current;
      return (
        allServiceChecksPassing(current, expected) &&
        named.every((name) =>
          (current.checks ?? []).some(
            (check) => check.name === name && check.status === "passing",
          ),
        )
      );
    }),
    Effect.catchTag(TRANSIENT_GET_TAGS, () => Effect.succeed(false)),
    Effect.repeat({
      schedule: Schedule.spaced(healthTimeoutMs / 10),
      until: (passing) => passing,
      times: 10,
    }),
    Effect.timeoutOrElse({
      duration: healthTimeoutMs,
      orElse: () => Effect.fail(notPassing()),
    }),
  );
  if (!passing) return yield* notPassing();
  return observed;
});

export const waitDestroyed = (appName: string, machineId: string) =>
  machines
    .waitMachine({
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
        while: (e) =>
          e._tag === "GatewayTimeout" || e._tag === "MachineWaitTimeout",
      }),
    );

export const ensureStarted = Effect.fn(function* (
  appName: string,
  machine: FlyMachine,
  skipLaunch: boolean,
  healthTimeoutMs = 60_000,
  expectedConfig?: FlyMachineConfig,
) {
  const machineId = machine.id;
  if (machineId === undefined || skipLaunch) return machine;
  const started = yield* Effect.gen(function* () {
    // Create/update responses can lag Fly's automatic launch.
    const current = yield* machines.getMachine({
      app_name: appName,
      machine_id: machineId,
    });
    yield* Effect.logDebug("Fly machine startup", {
      appName,
      machineId,
      state: current.state,
    });
    if (
      current.state === "stopped" ||
      current.state === "suspended" ||
      current.state === "failed"
    ) {
      yield* machines.startMachine({
        app_name: appName,
        machine_id: machineId,
      });
    }
    // Re-observe state between waits instead of retrying the wait in the SDK.
    yield* machines
      .waitMachine({
        app_name: appName,
        machine_id: machineId,
        state: "started",
        timeout: WAIT_TIMEOUT_SECONDS,
      })
      .pipe(Retry.none);
    return yield* machines.getMachine({
      app_name: appName,
      machine_id: machineId,
    });
  }).pipe(
    Effect.retry({
      times: 6,
      schedule: waitBackoff,
      while: (error) =>
        error._tag === "MachineStartFromCreatedState" ||
        error._tag === "MachineWaitTimeout" ||
        error._tag === "Conflict" ||
        error._tag === "GatewayTimeout",
    }),
    Effect.timeout("50 seconds"),
  );
  return yield* waitHealthy(
    appName,
    started,
    healthTimeoutMs,
    expectedConfig ?? machine.config,
  );
});

export const deleteMachine = Effect.fn(function* (
  appName: string,
  machineId: string,
) {
  if (appName.length === 0 || machineId.length === 0) return;
  yield* machines
    .deleteMachine({
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
});

const stopTimeoutMillis = (timeout: string | undefined) => {
  if (timeout === undefined) return undefined;
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
  };
  const parts = [...timeout.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
  return parts.map((part) => part[0]).join("") === timeout
    ? parts.reduce(
        (total, part) => total + Number(part[1]) * units[part[2]!]!,
        0,
      )
    : undefined;
};

export const sameStopConfig = (
  observed: FlyStopConfig | undefined,
  desired: FlyStopConfig | undefined,
) =>
  observed?.signal === desired?.signal &&
  stopTimeoutMillis(observed?.timeout) === stopTimeoutMillis(desired?.timeout);

export const retireMachine = Effect.fn(
  function* (
    appName: string,
    machineId: string,
    shutdown?: DeploymentPolicy["shutdown"],
  ) {
    const current = yield* getMachineById(appName, machineId);
    if (current === undefined) return;
    const stop =
      shutdown ??
      (current.config?.stop_config
        ? {
            signal: current.config.stop_config.signal ?? "SIGTERM",
            timeout: current.config.stop_config.timeout ?? "30s",
            timeoutMs:
              stopTimeoutMillis(current.config.stop_config.timeout) ?? 300_000,
          }
        : undefined);
    if (
      stop === undefined ||
      (current.cordoned === true &&
        current.config?.metadata?.[alchemyMetadataKeys.phase] === "candidate")
    )
      return yield* deleteMachine(appName, machineId);
    if (current.state !== "stopped" && current.state !== "created") {
      yield* machines.cordonMachine({
        app_name: appName,
        machine_id: machineId,
      });
      if (hasPublishedService(current.config?.services))
        yield* Effect.sleep("10 seconds");
      yield* machines.stopMachine({
        app_name: appName,
        machine_id: machineId,
        signal: stop.signal,
        timeout: stop.timeout,
      });
      yield* machines
        .waitMachine({
          app_name: appName,
          machine_id: machineId,
          state: "stopped",
          timeout: WAIT_TIMEOUT_SECONDS,
        })
        .pipe(
          Retry.none,
          Effect.retry({
            times: 10,
            schedule: Schedule.spaced(Math.max(500, stop.timeoutMs / 10)),
            while: (error) =>
              error._tag === "MachineWaitTimeout" ||
              error._tag === "GatewayTimeout",
          }),
          Effect.timeout(stop.timeoutMs + 15_000),
        );
    }
    yield* machines
      .deleteMachine({ app_name: appName, machine_id: machineId, force: false })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
    yield* waitDestroyed(appName, machineId);
  },
  Effect.catchTag("NotFound", () => Effect.void),
);

const mountedDisksOf = (
  machine: FlyMachine,
  volumesById: Map<string, FlyVolume>,
): MountedDisk[] =>
  (machine.config?.mounts ?? []).flatMap((mount) => {
    const volumeId = mount.volume;
    const path = mount.path;
    if (volumeId === undefined || path === undefined) return [];
    const volume = volumesById.get(volumeId);
    return [
      {
        path,
        volumeId,
        sizeGb: volume?.size_gb ?? 0,
        name: volume?.name ?? "",
      },
    ];
  });

export const toReplica = (
  machine: FlyMachine,
  volumesById: Map<string, FlyVolume>,
): Replica => ({
  machineId: machine.id ?? "",
  name: machine.name ?? "",
  region: machine.region ?? "",
  state: machine.state ?? "",
  instanceId: machine.instance_id,
  privateIp: machine.private_ip,
  imageRef: toImageRef(machine.image_ref),
  guest: toGuestAttrs(machine.config?.guest),
  mounts: mountedDisksOf(machine, volumesById),
});

export const toReplicaSet = (
  replicas: Replica[],
  appName: string,
  baseName: string,
  services?: FlyMachineService[],
): ReplicaSet => {
  const primary = replicas[0];
  return {
    appName,
    machineId: primary?.machineId ?? "",
    machineIds: replicas.map((replica) => replica.machineId),
    name: primary?.name ?? baseName,
    baseName,
    region: primary?.region ?? "",
    state: primary?.state ?? "",
    instanceId: primary?.instanceId,
    privateIp: primary?.privateIp,
    imageRef: primary?.imageRef,
    guest: primary?.guest,
    url: hasPublishedService(services)
      ? `https://${appName}.fly.dev`
      : undefined,
    count: replicas.length,
    mounts: primary?.mounts ?? [],
    replicas,
  };
};

export const ownedReplicas = (
  listed: FlyMachine[],
  input: {
    metadata: Record<string, string>;
    resourceInstanceId: string;
    fqn: string;
    baseName?: string;
    machineIds?: readonly string[];
  },
) =>
  listed.filter((machine) => {
    const metadata = machine.config?.metadata ?? {};
    if (
      !Object.entries(input.metadata).every(
        ([key, value]) => metadata[key] === value,
      )
    )
      return false;
    if (metadata[alchemyMetadataKeys.instance] !== undefined) {
      return (
        metadata[alchemyMetadataKeys.instance] === input.resourceInstanceId &&
        metadata[alchemyMetadataKeys.fqn] === input.fqn
      );
    }
    return (
      (machine.id !== undefined && input.machineIds?.includes(machine.id)) ||
      (input.baseName !== undefined &&
        (machine.name === input.baseName ||
          machine.name ===
            replicaMachineName(input.baseName, replicaIndexOf(machine), 2)))
    );
  });

export const listReplicas = Effect.fn(function* (input: {
  appName: string;
  id: string;
  type: FlyAlchemyType;
}) {
  const machines = yield* listMachinesByApp(input.appName);
  return machines
    .filter(
      (machine) =>
        isOwnedType(machine, input.type) && alchemyIdOf(machine) === input.id,
    )
    .sort((left, right) => replicaIndexOf(left) - replicaIndexOf(right));
});

export const listReplicaSets = Effect.fn(function* (type: FlyAlchemyType) {
  const apps = yield* listOwnedApps();
  const groups = yield* Effect.forEach(
    apps,
    (app) =>
      listMachinesByApp(app.appName).pipe(
        Effect.map((machines) => {
          const owned = machines.filter((machine) =>
            isOwnedType(machine, type),
          );
          const byId = new Map<string, FlyMachine[]>();
          for (const machine of owned) {
            const id = alchemyIdOf(machine);
            if (id === undefined) continue;
            const metadata = machine.config?.metadata;
            const key = JSON.stringify([
              metadata?.[alchemyMetadataKeys.stack],
              metadata?.[alchemyMetadataKeys.stage],
              metadata?.[alchemyMetadataKeys.fqn] ?? id,
              metadata?.[alchemyMetadataKeys.instance],
              metadata?.[alchemyMetadataKeys.generation],
            ]);
            const group = byId.get(key) ?? [];
            group.push(machine);
            byId.set(key, group);
          }
          return [...byId.values()].map((group) => {
            const sorted = [...group].sort(
              (left, right) => replicaIndexOf(left) - replicaIndexOf(right),
            );
            const replicas = sorted.map((machine) =>
              toReplica(machine, new Map()),
            );
            return toReplicaSet(
              replicas,
              app.appName,
              replicas[0]?.name ?? "",
              sorted[0]?.config?.services,
            );
          });
        }),
      ),
    { concurrency: 8 },
  );
  return groups.flat();
});

const pickVolume = (
  group: FlyVolume[],
  used: Set<string>,
  preferId: string | undefined,
): FlyVolume | undefined => {
  if (preferId !== undefined && !used.has(preferId)) {
    const preferred = group.find((volume) => volume.id === preferId);
    if (preferred !== undefined) return preferred;
  }
  return group.find(
    (volume) => volume.id !== undefined && !used.has(volume.id),
  );
};

export interface ReconcileReplicasInput {
  fqn: string;
  resourceInstanceId: string;
  policy: DeploymentPolicy;
  checks?: Record<string, MachineCheck>;
  id: string;
  type: FlyAlchemyType;
  appName: string;
  baseName: string;
  region: string;
  count: number;
  disks: DiskSpec[];
  skipLaunch?: boolean;
  minSecretsVersion?: number;
  outputMachineIds?: readonly string[];
  preferVolumeIds?: ReadonlyArray<ReadonlyArray<string>>;
  configDrifted: (
    machine: FlyMachine,
    desired: {
      mounts: FlyMachineMount[];
      metadata: Record<string, string>;
    },
  ) => boolean;
  buildConfig: (replica: {
    index: number;
    mounts: FlyMachineMount[];
    metadata: Record<string, string>;
  }) => FlyMachineConfig;
}

export const reconcileReplicas = Effect.fn(function* (
  input: ReconcileReplicasInput,
) {
  const ownership = yield* createMachineMetadata(input.id, input.type);
  const alchemy = {
    ...ownership,
    [alchemyMetadataKeys.instance]: input.resourceInstanceId,
    [alchemyMetadataKeys.fqn]: input.fqn,
    [alchemyMetadataKeys.baseName]: input.baseName,
  };
  const buildConfig: ReconcileReplicasInput["buildConfig"] = (replica) => ({
    ...input.buildConfig(replica),
    checks:
      input.checks === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(input.checks).map(([name, check]) => [
              name,
              toFlyServiceCheck(check),
            ]),
          ),
    stop_config:
      input.policy.shutdown === undefined
        ? undefined
        : {
            signal: input.policy.shutdown.signal,
            timeout: input.policy.shutdown.timeout,
          },
  });
  const config = buildConfig({ index: 0, mounts: [], metadata: alchemy });
  yield* validateDeployment(
    input.policy,
    config,
    input.disks.length > 0,
    input.skipLaunch,
  );
  if (input.policy.bluegreen)
    return yield* reconcileBlueGreen(
      { ...input, buildConfig },
      ownership,
      alchemy,
    );
  const desiredNames = new Set(
    Array.from({ length: input.count }, (_, index) =>
      replicaMachineName(input.baseName, index, input.count),
    ),
  );
  const listed = yield* listMachinesByApp(input.appName);
  const owned = ownedReplicas(listed, {
    ...input,
    metadata: ownership,
    machineIds: input.outputMachineIds,
  });
  const byIndex = new Map<number, FlyMachine>();
  const preferIds = new Set(
    (input.outputMachineIds ?? []).filter((id) => id.length > 0),
  );
  for (const machine of owned) {
    const id = machine.id;
    if (id !== undefined && preferIds.has(id)) {
      byIndex.set(replicaIndexOf(machine), machine);
    }
  }
  for (const machine of owned) {
    const name = machine.name;
    if (
      name === undefined ||
      (!desiredNames.has(name) &&
        machine.config?.metadata?.[alchemyMetadataKeys.instance] !==
          input.resourceInstanceId)
    )
      continue;
    const index = replicaIndexOf(machine);
    if (!byIndex.has(index)) byIndex.set(index, machine);
  }

  for (const [index, machine] of byIndex) {
    if (index >= input.count && machine.id !== undefined) {
      yield* retireMachine(input.appName, machine.id, input.policy.shutdown);
      byIndex.delete(index);
    }
  }

  const groups: Array<{
    disk: DiskSpec;
    name: string;
    volumes: FlyVolume[];
    extras: FlyVolume[];
  }> = [];
  for (const [diskIndex, disk] of input.disks.entries()) {
    const name = yield* volumeGroupName(input.id, disk);
    const preferIds = (input.preferVolumeIds ?? [])
      .map((replica) => replica[diskIndex])
      .filter((id): id is string => id !== undefined && id.length > 0);
    const ensured = yield* ensureVolumeGroup({
      appName: input.appName,
      name,
      region: input.region,
      count: input.count,
      disk,
      preferIds,
    });
    groups.push({ disk, name, ...ensured });
  }

  const usedVolumeIds = new Set<string>();
  const live: FlyMachine[] = [];
  for (let index = 0; index < input.count; index++) {
    const name = replicaMachineName(input.baseName, index, input.count);
    const metadata = {
      ...alchemy,
      [alchemyMetadataKeys.replica]: String(index),
    };
    const prefer = input.preferVolumeIds?.[index] ?? [];
    const mounts: FlyMachineMount[] = [];
    for (const [diskIndex, group] of groups.entries()) {
      const volume = pickVolume(
        group.volumes,
        usedVolumeIds,
        prefer[diskIndex],
      );
      const volumeId = volume?.id;
      if (volumeId === undefined) {
        return yield* new ReplicaNotCreated({
          name,
          appName: input.appName,
        });
      }
      usedVolumeIds.add(volumeId);
      mounts.push({ volume: volumeId, path: group.disk.path });
    }
    const config = buildConfig({ index, mounts, metadata });
    let current = byIndex.get(index);
    if (current === undefined) {
      const created = yield* machines
        .createMachine({
          app_name: input.appName,
          name,
          region: input.region,
          config,
          skip_launch: input.skipLaunch === true ? true : undefined,
          min_secrets_version: input.minSecretsVersion,
        })
        .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
      current =
        created ??
        (yield* listMachinesByApp(input.appName).pipe(
          Effect.map((machines) =>
            machines.find((machine) => machine.name === name),
          ),
        ));
      if (current === undefined || current.id === undefined) {
        return yield* new ReplicaNotCreated({
          name,
          appName: input.appName,
        });
      }
    } else if (
      !deepEqual(current.config?.checks ?? {}, config.checks ?? {}, {
        stripNullish: true,
      }) ||
      !sameStopConfig(current.config?.stop_config, config.stop_config) ||
      input.configDrifted(current, {
        mounts,
        metadata,
      })
    ) {
      const updated = yield* machines
        .updateMachine({
          app_name: input.appName,
          machine_id: current.id ?? "",
          config,
          skip_launch: input.skipLaunch === true ? true : undefined,
          min_secrets_version: input.minSecretsVersion,
        })
        .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
      if (updated !== undefined) current = updated;
    }

    current = yield* ensureStarted(
      input.appName,
      current,
      input.skipLaunch === true,
      input.policy.healthTimeoutMs,
      config,
    );
    if (current.cordoned === true && !input.skipLaunch) {
      yield* setRouting(input.appName, current.id!, false);
      if (hasPublishedService(config.services))
        yield* Effect.sleep("10 seconds");
      current = yield* waitHealthy(
        input.appName,
        current,
        input.policy.healthTimeoutMs,
        config,
      );
    }
    live.push(current);
  }

  const liveIds = new Set(live.map((machine) => machine.id));
  yield* Effect.forEach(
    owned.filter((machine) => !liveIds.has(machine.id)),
    (machine) =>
      retireMachine(input.appName, machine.id!, input.policy.shutdown),
    { concurrency: 4 },
  );

  for (const group of groups) {
    for (const extra of group.extras) {
      const volumeId = extra.id;
      if (volumeId === undefined || usedVolumeIds.has(volumeId)) continue;
      yield* deleteVolume(input.appName, volumeId);
    }
  }

  const volumesById = new Map<string, FlyVolume>();
  for (const group of groups) {
    for (const volume of group.volumes) {
      if (volume.id !== undefined) volumesById.set(volume.id, volume);
    }
  }
  const fresh = yield* Effect.forEach(
    live,
    (machine) =>
      machine.id === undefined
        ? Effect.succeed(machine)
        : getMachineById(input.appName, machine.id).pipe(
            Effect.map((next) => next ?? machine),
          ),
    { concurrency: 4 },
  );
  const replicas = fresh.map((machine) => toReplica(machine, volumesById));
  return toReplicaSet(
    replicas,
    input.appName,
    input.baseName,
    fresh[0]?.config?.services,
  );
});

export const deleteReplicaSet = Effect.fn(function* (input: {
  appName: string;
  id: string;
  type: FlyAlchemyType;
  fqn: string;
  resourceInstanceId: string;
  shutdown?: DeploymentPolicy["shutdown"];
  force?: boolean;
  machineIds: readonly string[];
  volumeIds: readonly string[];
}) {
  const owned = input.force
    ? []
    : ownedReplicas(yield* listMachinesByApp(input.appName), {
        ...input,
        metadata: yield* createMachineMetadata(input.id, input.type),
      });
  const ids = input.force
    ? input.machineIds
    : owned.flatMap((machine) => (machine.id ? [machine.id] : []));
  yield* Effect.forEach(
    ids.filter((id) => id.length > 0),
    (machineId) =>
      input.force
        ? deleteMachine(input.appName, machineId)
        : retireMachine(input.appName, machineId, input.shutdown),
    { concurrency: 4 },
  );
  yield* Effect.forEach(
    [...new Set(input.volumeIds)].filter((id) => id.length > 0),
    (volumeId) => deleteVolume(input.appName, volumeId),
    { concurrency: 4 },
  );
});

export const volumeIdsOf = (set: {
  mounts?: readonly MountedDisk[];
  replicas?: readonly Replica[];
}): string[] => {
  const ids = new Set<string>();
  for (const mount of set.mounts ?? []) ids.add(mount.volumeId);
  for (const replica of set.replicas ?? []) {
    for (const mount of replica.mounts) ids.add(mount.volumeId);
  }
  return [...ids];
};

export const groupGenerations = (machines: FlyMachine[]) => {
  const groups = new Map<string | undefined, FlyMachine[]>();
  for (const machine of machines) {
    const generation =
      machine.config?.metadata?.[alchemyMetadataKeys.generation];
    const group = groups.get(generation) ?? [];
    group.push(machine);
    groups.set(generation, group);
  }
  return groups;
};

export const observeReplicaSet = Effect.fn(function* (input: {
  appName?: string;
  fqn: string;
  resourceInstanceId: string;
  id: string;
  type: FlyAlchemyType;
  machineIds?: readonly string[];
  baseName?: string;
}) {
  if (input.appName === undefined) return undefined;
  const owned = ownedReplicas(yield* listMachinesByApp(input.appName), {
    ...input,
    metadata: yield* createMachineMetadata(input.id, input.type),
  });
  const groups = groupGenerations(owned);
  const committed = [...groups.entries()]
    .filter(([generation, group]) => {
      if (generation === undefined) return false;
      const count = Number(
        group[0]?.config?.metadata?.[alchemyMetadataKeys.count],
      );
      return (
        group.length === count &&
        new Set(group.map(replicaIndexOf)).size === count &&
        group.every(
          (machine) =>
            machine.config?.metadata?.[alchemyMetadataKeys.phase] ===
              "active" && machine.cordoned === false,
        )
      );
    })
    .sort(
      ([, a], [, b]) =>
        Number(b[0]?.config?.metadata?.[alchemyMetadataKeys.sequence] ?? 0) -
        Number(a[0]?.config?.metadata?.[alchemyMetadataKeys.sequence] ?? 0),
    );
  const listed = (committed[0]?.[1] ?? groups.get(undefined) ?? []).sort(
    (a, b) => replicaIndexOf(a) - replicaIndexOf(b),
  );
  const rolloutPending = owned.some((machine) => !listed.includes(machine));
  if (listed.length > 0) {
    const volumesById = new Map<string, FlyVolume>();
    for (const machine of listed) {
      for (const mount of machine.config?.mounts ?? []) {
        const volumeId = mount.volume;
        if (volumeId === undefined || volumesById.has(volumeId)) continue;
        const volume = yield* getVolumeById(input.appName, volumeId);
        if (volume !== undefined) volumesById.set(volumeId, volume);
      }
    }
    const replicas = listed.map((machine) => toReplica(machine, volumesById));
    return {
      ...toReplicaSet(
        replicas,
        input.appName,
        listed[0]?.config?.metadata?.[alchemyMetadataKeys.baseName] ??
          input.baseName ??
          replicas[0]?.name ??
          "",
        listed[0]?.config?.services,
      ),
      rolloutPending,
    };
  }
  if (owned.length)
    return {
      ...toReplicaSet([], input.appName, input.baseName ?? ""),
      region: owned[0]?.region ?? "",
      rolloutPending: true,
    };
  return undefined;
});
