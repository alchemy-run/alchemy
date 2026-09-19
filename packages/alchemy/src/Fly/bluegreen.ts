import * as machines from "@distilled.cloud/fly-io/machines";
import type { Machine } from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { deepEqual } from "../Diff.ts";
import { sha256Object } from "../Util/sha256.ts";
import { alchemyMetadataKeys as keys } from "./Metadata.ts";
import {
  deleteMachine,
  ensureStarted,
  getMachineById,
  groupGenerations,
  hasPublishedService,
  listMachinesByApp,
  ownedReplicas,
  ReplicaNotCreated,
  replicaIndexOf,
  retireMachine,
  sameStopConfig,
  toReplica,
  toReplicaSet,
  waitHealthy,
  type ReconcileReplicasInput,
} from "./replicas.ts";

const metadataOf = (machine: Machine) =>
  Object.fromEntries(
    Object.entries(machine.config?.metadata ?? {}).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  );

const setMetadata = (
  appName: string,
  machine: Machine,
  metadata: Record<string, string>,
) =>
  machines
    .updateMachineMetadata({
      app_name: appName,
      machine_id: machine.id!,
      metadata,
    })
    .pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          machine.config = { ...machine.config, metadata };
        }),
      ),
    );

const phase = (appName: string, machine: Machine, value: string) =>
  setMetadata(appName, machine, {
    ...metadataOf(machine),
    [keys.phase]: value,
  });

export const setRouting = (
  appName: string,
  machineId: string,
  cordoned: boolean,
) =>
  Effect.gen(function* () {
    const request = { app_name: appName, machine_id: machineId };
    yield* cordoned
      ? machines.cordonMachine(request)
      : machines.uncordonMachine(request);
    yield* getMachineById(appName, machineId).pipe(
      Effect.filterOrFail(
        (machine) => machine !== undefined && machine.cordoned === cordoned,
        () => new ReplicaNotCreated({ appName, name: machineId }),
      ),
      Effect.retry({
        times: 8,
        schedule: Schedule.spaced("500 millis"),
        while: (error) => error._tag === "Fly.ReplicaNotCreated",
      }),
    );
  });

const pinnedImage = (machine: Machine) => {
  const image = machine.image_ref;
  if (!image?.digest || !image.repository) return undefined;
  return `${image.registry ? `${image.registry}/` : ""}${image.repository}@${image.digest}`;
};

/** Cloud metadata records preparation and promotion; replica zero commits a complete set. */
export const reconcileBlueGreen = Effect.fn(function* (
  input: ReconcileReplicasInput,
  ownership: Record<string, string>,
  metadata: Record<string, string>,
) {
  const config = input.buildConfig({ index: 0, mounts: [], metadata });
  const workload = yield* sha256Object({
    config,
    count: input.count,
    minSecretsVersion: input.minSecretsVersion,
    region: input.region,
  });
  const observe = listMachinesByApp(input.appName).pipe(
    Effect.map((listed) =>
      ownedReplicas(listed, {
        ...input,
        metadata: ownership,
        machineIds: input.outputMachineIds,
      }),
    ),
  );
  const owned = yield* observe;
  const matches = (machine: Machine) => {
    const observed = metadataOf(machine);
    const pinned = observed[keys.image];
    if (pinned !== undefined && pinned !== pinnedImage(machine)) return false;
    return (
      observed[keys.workload] === workload &&
      !input.configDrifted(
        pinned === undefined
          ? machine
          : { ...machine, config: { ...machine.config, image: config.image } },
        {
          mounts: [],
          metadata: {
            ...Object.fromEntries(
              Object.entries(observed).filter(([key]) =>
                key.startsWith("alchemy."),
              ),
            ),
            ...metadata,
          },
        },
      ) &&
      deepEqual(machine.config?.checks ?? {}, config.checks ?? {}, {
        stripNullish: true,
      }) &&
      sameStopConfig(machine.config?.stop_config, config.stop_config)
    );
  };
  const groups = groupGenerations(owned);
  const reusable = [...groups.entries()]
    .filter(
      ([generation, group]) => generation !== undefined && group.every(matches),
    )
    .sort(
      ([, a], [, b]) =>
        Number(b[0]?.config?.metadata?.[keys.sequence] ?? 0) -
        Number(a[0]?.config?.metadata?.[keys.sequence] ?? 0),
    )[0];
  const generation =
    reusable?.[0] ??
    (yield* sha256Object({
      workload,
      predecessors: owned.map((machine) => machine.id).sort(),
    })).slice(0, 20);
  const desired = reusable?.[1] ?? [];
  const sequence =
    desired[0]?.config?.metadata?.[keys.sequence] ??
    String(
      1 +
        Math.max(
          0,
          ...owned.map((machine) =>
            Number(machine.config?.metadata?.[keys.sequence] ?? 0),
          ),
        ),
    );
  const predecessors = owned.filter(
    (machine) => machine.config?.metadata?.[keys.generation] !== generation,
  );
  const candidates: Machine[] = [];
  let image = desired[0] ? pinnedImage(desired[0]) : undefined;

  yield* Effect.gen(function* () {
    for (let index = 0; index < input.count; index++) {
      const suffix = `-${generation}-${index}`;
      const name = `${input.baseName.slice(0, 30 - suffix.length).replace(/-+$/g, "")}${suffix}`;
      let current = desired.find(
        (machine) => replicaIndexOf(machine) === index,
      );
      if (current === undefined) {
        yield* Effect.logInfo("Creating Fly replacement Machine", {
          appName: input.appName,
          name,
        });
        current = yield* machines
          .createMachine({
            app_name: input.appName,
            name,
            region: input.region,
            config: {
              ...input.buildConfig({
                index,
                mounts: [],
                metadata: {
                  ...metadata,
                  [keys.replica]: String(index),
                  [keys.generation]: generation,
                  [keys.workload]: workload,
                  [keys.phase]: "candidate",
                  [keys.sequence]: sequence,
                  [keys.count]: String(input.count),
                  ...(image ? { [keys.image]: image } : {}),
                },
              }),
              image: image ?? config.image,
            },
            skip_service_registration: true,
            min_secrets_version: input.minSecretsVersion,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              observe.pipe(
                Effect.map((listed) =>
                  listed.find(
                    (machine) =>
                      machine.name === name &&
                      machine.config?.metadata?.[keys.generation] ===
                        generation &&
                      replicaIndexOf(machine) === index &&
                      matches(machine),
                  ),
                ),
              ),
            ),
          );
      }
      if (!current?.id)
        return yield* new ReplicaNotCreated({ appName: input.appName, name });
      const started = yield* ensureStarted(
        input.appName,
        current,
        false,
        input.policy.healthTimeoutMs,
        config,
      );
      const resolvedImage = pinnedImage(started);
      if (!resolvedImage || (image !== undefined && image !== resolvedImage))
        return yield* new ReplicaNotCreated({ appName: input.appName, name });
      image = resolvedImage;
      if (started.config?.metadata?.[keys.image] !== image) {
        yield* setMetadata(input.appName, started, {
          ...metadataOf(started),
          [keys.image]: image,
        });
      }
      candidates.push(started);
    }
    // Pinning metadata resets check reports without restarting the process.
    yield* Effect.forEach(candidates, (machine) =>
      waitHealthy(input.appName, machine, input.policy.healthTimeoutMs, config),
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const found = (yield* observe).filter(
          (machine) =>
            machine.config?.metadata?.[keys.generation] === generation,
        );
        // Once any promotion may have happened, preserve capacity for a retry.
        if (
          found.every(
            (machine) =>
              machine.config?.metadata?.[keys.phase] === "candidate" &&
              machine.cordoned === true,
          )
        ) {
          yield* Effect.forEach(
            found,
            (machine) => deleteMachine(input.appName, machine.id!),
            { concurrency: 4 },
          );
        }
        return yield* Effect.fail(error);
      }),
    ),
  );

  const needsPromotion = candidates.some(
    (machine) =>
      machine.cordoned !== false ||
      machine.config?.metadata?.[keys.phase] !== "active",
  );
  if (needsPromotion) {
    yield* Effect.logInfo("Enabling Fly replacement traffic", {
      appName: input.appName,
    });
    yield* Effect.forEach(candidates, (machine) =>
      phase(input.appName, machine, "promoting"),
    );
    yield* Effect.forEach(candidates, (machine) =>
      setRouting(input.appName, machine.id!, false),
    );
    if (hasPublishedService(config.services)) yield* Effect.sleep("10 seconds");
    // Replica zero is committed last. Readers never publish a partial generation.
    yield* Effect.forEach([...candidates].reverse(), (machine) =>
      phase(input.appName, machine, "active"),
    );
    for (const [index, machine] of candidates.entries()) {
      candidates[index] = yield* waitHealthy(
        input.appName,
        machine,
        input.policy.healthTimeoutMs,
        config,
      );
    }
  }
  // Metadata updates reset health reports; stamp legacy ownership only after promotion.
  for (const machine of predecessors) {
    if (machine.config?.metadata?.[keys.instance] === undefined) {
      yield* setMetadata(input.appName, machine, {
        ...metadataOf(machine),
        ...metadata,
      });
    }
  }
  if (predecessors.length) {
    yield* Effect.logInfo("Retiring previous Fly generation", {
      appName: input.appName,
      count: predecessors.length,
    });
    yield* Effect.forEach(predecessors, (machine) =>
      phase(input.appName, machine, "retiring"),
    );
    yield* Effect.forEach(
      predecessors,
      (machine) =>
        retireMachine(input.appName, machine.id!, input.policy.shutdown),
      { concurrency: 4 },
    );
  }
  return toReplicaSet(
    candidates.map((machine) => toReplica(machine, new Map())),
    input.appName,
    input.baseName,
    config.services,
  );
});
