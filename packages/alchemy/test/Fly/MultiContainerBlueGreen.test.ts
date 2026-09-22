import { DeploymentRecoveryAmbiguous } from "@/Fly/bluegreen";
import { alchemyMetadataKeys as keys } from "@/Fly/Metadata";
import { observeReplicaSet } from "@/Fly/replicas";
import { Stack } from "@/Stack";
import { Stage } from "@/Stage";
import { expect, it, describe } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  multiContainerClient,
  initialConfig,
  appName,
  metadata,
  singleConfig,
  pins,
  reconcile,
  reconcileWith,
  replacementConfig,
  serviceConfig,
} from "./fixtures/multi-container-bluegreen.ts";
import { withControlledClient } from "./fixtures/protocol-branches.ts";

const imageSet = JSON.stringify([
  { name: "api", image: pins.api },
  { name: "worker", image: pins.worker },
]);
const mutations = (events: Array<{ method: string; path: string }>) =>
  events.filter(
    (event) => event.method !== "GET" && !event.path.endsWith("/lease"),
  );

const observe = (machineIds: readonly string[]) =>
  observeReplicaSet({
    appName,
    id: "Worker",
    type: "Fly.Machine",
    fqn: metadata[keys.fqn],
    resourceInstanceId: metadata[keys.instance],
    machineIds,
    baseName: metadata[keys.baseName],
  }).pipe(
    Effect.provideService(Stack, {
      name: appName,
      stage: "pure",
      resources: {},
      bindings: {},
      actions: {},
    }),
    Effect.provideService(Stage, "pure"),
  );

describe.sequential("multi-container bluegreen protocol", () => {
  it.live(
    "creates two checked replicas with complete immutable image metadata and reuses them",
    () =>
      Effect.gen(function* () {
        const fixture = yield* multiContainerClient();
        const first = yield* reconcile.pipe(
          withControlledClient(fixture.client),
        );
        expect(first.machineIds).toHaveLength(2);
        expect(fixture.machines.size).toBe(2);
        for (const machine of fixture.machines.values()) {
          expect(
            machine.config?.containers?.map(({ name, image }) => ({
              name,
              image,
            })),
          ).toEqual([
            { name: "worker", image: pins.worker },
            { name: "api", image: pins.api },
          ]);
          expect(machine.config?.metadata?.[keys.protocol]).toBe("2");
          expect(machine.config?.metadata?.[keys.containerImageSet]).toBe(
            imageSet,
          );
          expect(machine.config?.metadata?.[keys.phase]).toBe("active");
          expect(machine.config?.metadata?.[keys.checkedInstance]).toBe(
            machine.instance_id,
          );
          expect(machine.cordoned).toBe(false);
        }
        const count = fixture.events.length;
        const second = yield* reconcile.pipe(
          withControlledClient(fixture.client),
        );
        expect(second.machineIds).toEqual(first.machineIds);
        expect(mutations(fixture.events.slice(count))).toEqual([]);
      }),
    { timeout: 10_000 },
  );

  it.live(
    "container declaration order alone leaves the generation untouched",
    () =>
      Effect.gen(function* () {
        const fixture = yield* multiContainerClient();
        const first = yield* reconcile.pipe(
          withControlledClient(fixture.client),
        );
        const before = fixture.events.length;
        const reordered = {
          ...initialConfig,
          containers: [...(initialConfig.containers ?? [])].reverse(),
        };
        const second = yield* reconcileWith(reordered).pipe(
          withControlledClient(fixture.client),
        );
        expect(second.machineIds).toEqual(first.machineIds);
        expect(mutations(fixture.events.slice(before))).toEqual([]);
      }),
    { timeout: 10_000 },
  );

  it.live(
    "adding and removing a named member each replaces the whole two-replica generation",
    () =>
      Effect.gen(function* () {
        const fixture = yield* multiContainerClient();
        const first = yield* reconcile.pipe(
          withControlledClient(fixture.client),
        );
        const expanded = {
          ...initialConfig,
          containers: [
            ...(initialConfig.containers ?? []),
            {
              name: "sidecar",
              image: `registry.test/sidecar@sha256:${"f".repeat(64)}`,
            },
          ],
        };
        const second = yield* reconcileWith(expanded).pipe(
          withControlledClient(fixture.client),
        );
        expect(
          second.machineIds.every((id) => !first.machineIds.includes(id)),
        ).toBe(true);
        expect(fixture.machines.size).toBe(2);
        const third = yield* reconcile.pipe(
          withControlledClient(fixture.client),
        );
        expect(
          third.machineIds.every((id) => !second.machineIds.includes(id)),
        ).toBe(true);
        expect(fixture.machines.size).toBe(2);
        expect(
          fixture.events.filter(
            (event) =>
              event.method === "POST" && event.path.endsWith("/machines"),
          ),
        ).toHaveLength(6);
      }),
    { timeout: 20_000 },
  );

  it.live(
    "replaces a real protocol-1 single-image generation with protocol-2 group",
    () =>
      Effect.gen(function* () {
        const fixture = yield* multiContainerClient();
        const old = yield* reconcileWith(singleConfig).pipe(
          withControlledClient(fixture.client),
        );
        expect(
          [...fixture.machines.values()].every(
            (machine) => machine.config?.metadata?.[keys.protocol] === "1",
          ),
        ).toBe(true);
        const next = yield* reconcile.pipe(
          withControlledClient(fixture.client),
        );
        expect(
          next.machineIds.every((id) => !old.machineIds.includes(id)),
        ).toBe(true);
        expect(fixture.machines.size).toBe(2);
        expect(
          [...fixture.machines.values()].every(
            (machine) =>
              machine.config?.metadata?.[keys.protocol] === "2" &&
              machine.config.metadata[keys.containerImageSet] === imageSet,
          ),
        ).toBe(true);
      }),
    { timeout: 20_000 },
  );

  it.live(
    "restores service autostop with complete pins and checks the new instance",
    () =>
      Effect.gen(function* () {
        const fixture = yield* multiContainerClient();
        const result = yield* reconcileWith(serviceConfig).pipe(
          withControlledClient(fixture.client),
        );
        expect(result.machineIds).toHaveLength(2);
        const run = [...fixture.machines.values()].find(
          (machine) => machine.config?.metadata?.[keys.role] === "run",
        );
        expect(run).toBeDefined();
        expect(run?.config?.services?.[0]?.autostop).toBe("stop");
        expect(run?.config?.metadata?.[keys.containerImageSet]).toBe(imageSet);
        expect(run?.config?.metadata?.[keys.checkedInstance]).toBe(
          run?.instance_id,
        );
        const updates = fixture.events.filter(
          (event) =>
            event.method === "POST" &&
            event.path.endsWith(`/machines/${run?.id}`),
        );
        expect(updates).toHaveLength(1);
        expect(run?.instance_id).toBe("instance-3");
        expect(
          run?.config?.containers?.map(({ name, image }) => ({ name, image })),
        ).toEqual([
          { name: "worker", image: pins.worker },
          { name: "api", image: pins.api },
        ]);
      }),
    { timeout: 10_000 },
  );

  it.live(
    "does not commit restored service config without checks for the new instance",
    () =>
      Effect.gen(function* () {
        const fixture = yield* multiContainerClient({ staleAfterUpdate: true });
        const result = yield* reconcileWith(serviceConfig).pipe(
          withControlledClient(fixture.client),
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        expect(
          [...fixture.machines.values()].some(
            (machine) =>
              machine.config?.metadata?.[keys.restored] === "true" &&
              machine.config.metadata[keys.phase] !== "active" &&
              machine.config.metadata[keys.checkedInstance] !==
                machine.instance_id,
          ),
        ).toBe(true);
      }),
    { timeout: 10_000 },
  );

  it.live(
    "dependency ordering and empty optional fields do not replace a generation",
    () =>
      Effect.gen(function* () {
        const fixture = yield* multiContainerClient();
        const dependencies = [
          { name: "api", condition: "started" as const },
          { name: "metrics", condition: "started" as const },
        ];
        const before = {
          ...initialConfig,
          containers: [
            { name: "worker", image: pins.worker, depends_on: dependencies },
            { name: "api", image: pins.api },
            { name: "metrics", image: pins.api },
          ],
        };
        const first = yield* reconcileWith(before).pipe(
          withControlledClient(fixture.client),
        );
        const eventCount = fixture.events.length;
        const equivalent = {
          ...before,
          containers: before.containers.map((container) => ({
            ...container,
            env: {},
            healthchecks: [],
            depends_on: container.depends_on
              ? [...container.depends_on].reverse()
              : [],
          })),
        };
        const second = yield* reconcileWith(equivalent).pipe(
          withControlledClient(fixture.client),
        );
        expect(second.machineIds).toEqual(first.machineIds);
        expect(mutations(fixture.events.slice(eventCount))).toEqual([]);
        const changed = {
          ...equivalent,
          containers: equivalent.containers.map((container) => ({
            ...container,
            depends_on: container.depends_on.map((dependency) => ({
              ...dependency,
              condition: "healthy" as const,
            })),
          })),
        };
        const third = yield* reconcileWith(changed).pipe(
          withControlledClient(fixture.client),
        );
        expect(
          third.machineIds.some((id) => first.machineIds.includes(id)),
        ).toBe(false);
      }),
    { timeout: 10_000 },
  );

  for (const protocol of [undefined, "1"] as const) {
    for (const retainGeneration of [true, false]) {
      it.live(
        `missing/downgraded protocol ${protocol} cannot hide container recovery state (generation=${retainGeneration})`,
        () =>
          Effect.gen(function* () {
            const fixture = yield* multiContainerClient();
            const committed = yield* reconcile.pipe(
              withControlledClient(fixture.client),
            );
            for (const machine of fixture.machines.values()) {
              const changed = { ...machine.config?.metadata };
              if (protocol === undefined) delete changed[keys.protocol];
              else changed[keys.protocol] = protocol;
              if (!retainGeneration) delete changed[keys.generation];
              fixture.machines.set(machine.id!, {
                ...machine,
                config: { ...machine.config, metadata: changed },
              });
            }
            const observed = yield* observe(committed.machineIds).pipe(
              withControlledClient(fixture.client),
            );
            expect(observed?.rolloutPending).toBe(true);
            expect(observed?.machineIds).toEqual([]);
            const before = fixture.events.length;
            const result = yield* reconcile.pipe(
              withControlledClient(fixture.client),
              Effect.result,
            );
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure).toBeInstanceOf(
                DeploymentRecoveryAmbiguous,
              );
            }
            expect(fixture.machines.size).toBe(2);
            expect(mutations(fixture.events.slice(before))).toEqual([]);
          }),
        { timeout: 10_000 },
      );
    }
  }

  for (const damaged of [keys.generation, keys.count, keys.role] as const) {
    it.live(
      `missing protocol-2 ${damaged} preserves owned capacity`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* multiContainerClient();
          yield* reconcile.pipe(withControlledClient(fixture.client));
          const machine = [...fixture.machines.values()][0]!;
          const changed = { ...machine.config?.metadata };
          delete changed[damaged];
          fixture.machines.set(machine.id!, {
            ...machine,
            config: { ...machine.config, metadata: changed },
          });
          const before = fixture.events.length;
          const result = yield* reconcile.pipe(
            withControlledClient(fixture.client),
            Effect.result,
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure).toBeInstanceOf(DeploymentRecoveryAmbiguous);
          expect(fixture.machines.size).toBe(2);
          expect(mutations(fixture.events.slice(before))).toEqual([]);
        }),
      { timeout: 10_000 },
    );
  }

  for (const damaged of [keys.role, keys.count, keys.generation] as const) {
    it.live(
      `observer keeps malformed protocol-2 ${damaged} pending`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* multiContainerClient();
          const committed = yield* reconcile.pipe(
            withControlledClient(fixture.client),
          );
          const machine = [...fixture.machines.values()][0]!;
          const changed = { ...machine.config?.metadata };
          delete changed[damaged];
          fixture.machines.set(machine.id!, {
            ...machine,
            config: { ...machine.config, metadata: changed },
          });
          const observed = yield* observeReplicaSet({
            appName,
            id: "Worker",
            type: "Fly.Machine",
            fqn: metadata[keys.fqn],
            resourceInstanceId: metadata[keys.instance],
            machineIds: committed.machineIds,
            baseName: metadata[keys.baseName],
          }).pipe(
            withControlledClient(fixture.client),
            Effect.provideService(Stack, {
              name: appName,
              stage: "pure",
              resources: {},
              bindings: {},
              actions: {},
            }),
            Effect.provideService(Stage, "pure"),
          );
          expect(observed?.rolloutPending).toBe(true);
          expect(observed?.machineIds).toEqual([]);
        }),
      { timeout: 10_000 },
    );
  }

  for (const damaged of [keys.workload, keys.sequence, keys.roles] as const) {
    it.live(
      `observer rejects inconsistent protocol-2 ${damaged}`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* multiContainerClient();
          const committed = yield* reconcile.pipe(
            withControlledClient(fixture.client),
          );
          const machine = [...fixture.machines.values()][1]!;
          const changed = { ...machine.config?.metadata };
          if (damaged === keys.roles) {
            changed[keys.roles] = "idle,run";
            changed[keys.role] = "run";
          } else {
            changed[damaged] =
              damaged === keys.sequence ? "2" : "different-valid-workload";
          }
          fixture.machines.set(machine.id!, {
            ...machine,
            config: { ...machine.config, metadata: changed },
          });
          const observed = yield* observeReplicaSet({
            appName,
            id: "Worker",
            type: "Fly.Machine",
            fqn: metadata[keys.fqn],
            resourceInstanceId: metadata[keys.instance],
            machineIds: committed.machineIds,
            baseName: metadata[keys.baseName],
          }).pipe(
            withControlledClient(fixture.client),
            Effect.provideService(Stack, {
              name: appName,
              stage: "pure",
              resources: {},
              bindings: {},
              actions: {},
            }),
            Effect.provideService(Stage, "pure"),
          );
          expect(observed?.rolloutPending).toBe(true);
          expect(observed?.machineIds).toEqual([]);
        }),
      { timeout: 10_000 },
    );
  }

  it.live(
    "observer excludes unknown protocol with no generation from legacy fallback",
    () =>
      Effect.gen(function* () {
        const fixture = yield* multiContainerClient();
        const committed = yield* reconcile.pipe(
          withControlledClient(fixture.client),
        );
        const machine = [...fixture.machines.values()][0]!;
        const changed = { ...machine.config?.metadata };
        changed[keys.protocol] = "future";
        delete changed[keys.generation];
        fixture.machines.set(machine.id!, {
          ...machine,
          config: { ...machine.config, metadata: changed },
        });
        const observed = yield* observeReplicaSet({
          appName,
          id: "Worker",
          type: "Fly.Machine",
          fqn: metadata[keys.fqn],
          resourceInstanceId: metadata[keys.instance],
          machineIds: committed.machineIds,
          baseName: metadata[keys.baseName],
        }).pipe(
          withControlledClient(fixture.client),
          Effect.provideService(Stack, {
            name: appName,
            stage: "pure",
            resources: {},
            bindings: {},
            actions: {},
          }),
          Effect.provideService(Stage, "pure"),
        );
        expect(observed?.rolloutPending).toBe(true);
        expect(observed?.machineIds).toEqual([]);
      }),
    { timeout: 10_000 },
  );

  it.live(
    "a lost create response is recovered by name without a duplicate group",
    () =>
      Effect.gen(function* () {
        const fixture = yield* multiContainerClient({
          failOnce: "create-response",
        });
        const result = yield* reconcile.pipe(
          withControlledClient(fixture.client),
        );
        expect(result.machineIds).toHaveLength(2);
        expect(fixture.machines.size).toBe(2);
        expect(
          fixture.events.filter(
            (event) =>
              event.method === "POST" && event.path.endsWith("/machines"),
          ),
        ).toHaveLength(2);
        expect(
          [...fixture.machines.values()].every(
            (machine) =>
              machine.config?.metadata?.[keys.phase] === "active" &&
              machine.cordoned === false,
          ),
        ).toBe(true);
      }),
    { timeout: 10_000 },
  );

  for (const boundary of ["uncordon", "active", "delete"] as const) {
    it.live(
      `reconciles after ${boundary} interruption without losing predecessor capacity`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* multiContainerClient();
          const original = yield* reconcile.pipe(
            withControlledClient(fixture.client),
          );
          fixture.arm(boundary, 2);
          const interrupted = yield* reconcileWith(replacementConfig).pipe(
            withControlledClient(fixture.client),
            Effect.result,
          );
          expect(Result.isFailure(interrupted)).toBe(true);
          const survivors = original.machineIds.filter((id) =>
            fixture.machines.has(id),
          );
          expect(survivors.length).toBeGreaterThan(0);
          const candidates = [...fixture.machines.values()].filter(
            (machine) => !original.machineIds.includes(machine.id!),
          );
          expect(candidates).toHaveLength(2);
          if (boundary === "uncordon")
            expect(
              candidates.filter((machine) => machine.cordoned === false),
            ).toHaveLength(1);
          if (boundary === "active")
            expect(
              candidates.filter(
                (machine) =>
                  machine.config?.metadata?.[keys.phase] === "active",
              ),
            ).toHaveLength(1);
          if (boundary === "delete") expect(survivors).toHaveLength(1);
          const final = yield* reconcileWith(replacementConfig).pipe(
            withControlledClient(fixture.client),
          );
          expect(final.machineIds).toHaveLength(2);
          expect(
            final.machineIds.every((id) => !original.machineIds.includes(id)),
          ).toBe(true);
          expect(fixture.machines.size).toBe(2);
          expect(
            [...fixture.machines.values()].every(
              (machine) =>
                machine.config?.metadata?.[keys.phase] === "active" &&
                machine.config.metadata[keys.checkedInstance] ===
                  machine.instance_id &&
                machine.cordoned === false,
            ),
          ).toBe(true);
          expect(
            fixture.events.filter(
              (event) =>
                event.method === "POST" && event.path.endsWith("/machines"),
            ),
          ).toHaveLength(4);
        }),
      { timeout: 20_000 },
    );
  }

  it.live(
    "rejects a generation whose valid replicas disagree on workload identity",
    () =>
      Effect.gen(function* () {
        const fixture = yield* multiContainerClient();
        yield* reconcile.pipe(withControlledClient(fixture.client));
        const machine = [...fixture.machines.values()][1]!;
        fixture.machines.set(machine.id!, {
          ...machine,
          config: {
            ...machine.config,
            metadata: {
              ...machine.config?.metadata,
              [keys.workload]: "different-valid-workload",
            },
          },
        });
        const before = fixture.events.length;
        const result = yield* reconcile.pipe(
          withControlledClient(fixture.client),
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure).toBeInstanceOf(DeploymentRecoveryAmbiguous);
        expect(fixture.machines.size).toBe(2);
        expect(mutations(fixture.events.slice(before))).toEqual([]);
      }),
    { timeout: 10_000 },
  );

  it.live(
    "rejects an owned generation whose replicas have different complete pin sets",
    () =>
      Effect.gen(function* () {
        const fixture = yield* multiContainerClient();
        yield* reconcile.pipe(withControlledClient(fixture.client));
        const machine = [...fixture.machines.values()][1]!;
        const changedWorker = `registry.test/worker@sha256:${"c".repeat(64)}`;
        fixture.machines.set(machine.id!, {
          ...machine,
          config: {
            ...machine.config,
            containers: machine.config?.containers?.map((container) =>
              container.name === "worker"
                ? { ...container, image: changedWorker }
                : container,
            ),
            metadata: {
              ...machine.config?.metadata,
              [keys.containerImageSet]: JSON.stringify([
                { name: "api", image: pins.api },
                { name: "worker", image: changedWorker },
              ]),
            },
          },
        });
        const before = fixture.events.length;
        const result = yield* reconcileWith(replacementConfig).pipe(
          withControlledClient(fixture.client),
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure).toBeInstanceOf(DeploymentRecoveryAmbiguous);
        expect(fixture.machines.size).toBe(2);
        expect(mutations(fixture.events.slice(before))).toEqual([]);
      }),
    { timeout: 10_000 },
  );

  for (const tamper of [
    "protocol downgrade",
    "consistent pin change",
  ] as const) {
    it.live(
      `preserves predecessor if ${tamper} occurs after candidate commit`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* multiContainerClient();
          const original = yield* reconcile.pipe(
            withControlledClient(fixture.client),
          );
          fixture.tamperAfterActive((machines) => {
            const predecessor = machines.get(original.machineIds[0]!);
            if (!predecessor)
              throw new Error("Missing predecessor at commit hook");
            const changedWorker = `registry.test/worker@sha256:${"d".repeat(64)}`;
            const changedMetadata = { ...predecessor.config?.metadata };
            if (tamper === "protocol downgrade") {
              changedMetadata[keys.protocol] = "1";
            } else {
              changedMetadata[keys.containerImageSet] = JSON.stringify([
                { name: "api", image: pins.api },
                { name: "worker", image: changedWorker },
              ]);
            }
            machines.set(predecessor.id!, {
              ...predecessor,
              config: {
                ...predecessor.config,
                metadata: changedMetadata,
                containers:
                  tamper === "protocol downgrade"
                    ? predecessor.config?.containers
                    : predecessor.config?.containers?.map((container) =>
                        container.name === "worker"
                          ? { ...container, image: changedWorker }
                          : container,
                      ),
              },
            });
          });
          const result = yield* reconcileWith(replacementConfig).pipe(
            withControlledClient(fixture.client),
            Effect.result,
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure).toBeInstanceOf(DeploymentRecoveryAmbiguous);
          expect(fixture.machines.has(original.machineIds[0]!)).toBe(true);
          expect(
            fixture.events.some(
              (event) =>
                event.method === "DELETE" &&
                event.path.endsWith(`/machines/${original.machineIds[0]}`),
            ),
          ).toBe(false);
        }),
      { timeout: 20_000 },
    );
  }

  it.live(
    "unknown protocol preserves both replicas and makes no deployment mutation",
    () =>
      Effect.gen(function* () {
        const fixture = yield* multiContainerClient();
        yield* reconcile.pipe(withControlledClient(fixture.client));
        const machine = [...fixture.machines.values()][0]!;
        fixture.machines.set(machine.id!, {
          ...machine,
          config: {
            ...machine.config,
            metadata: {
              ...machine.config?.metadata,
              [keys.protocol]: "future",
            },
          },
        });
        const before = fixture.events.length;
        const result = yield* reconcile.pipe(
          withControlledClient(fixture.client),
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure).toBeInstanceOf(DeploymentRecoveryAmbiguous);
        expect(fixture.machines.size).toBe(2);
        expect(mutations(fixture.events.slice(before))).toEqual([]);
      }),
    { timeout: 10_000 },
  );

  for (const damaged of ["missing", "incomplete", "wrong pin"] as const) {
    it.live(
      `${damaged} image-set evidence preserves existing capacity`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* multiContainerClient();
          yield* reconcile.pipe(withControlledClient(fixture.client));
          const machine = [...fixture.machines.values()][0]!;
          const imageMetadata =
            damaged === "missing"
              ? undefined
              : damaged === "incomplete"
                ? JSON.stringify([{ name: "api", image: pins.api }])
                : JSON.stringify([
                    { name: "api", image: pins.api },
                    {
                      name: "worker",
                      image: `registry.test/worker@sha256:${"c".repeat(64)}`,
                    },
                  ]);
          const changed = { ...machine.config?.metadata };
          if (imageMetadata === undefined)
            delete changed[keys.containerImageSet];
          else changed[keys.containerImageSet] = imageMetadata;
          fixture.machines.set(machine.id!, {
            ...machine,
            config: { ...machine.config, metadata: changed },
          });
          const before = fixture.events.length;
          const result = yield* reconcile.pipe(
            withControlledClient(fixture.client),
            Effect.result,
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure).toBeInstanceOf(DeploymentRecoveryAmbiguous);
          expect(fixture.machines.size).toBe(2);
          expect(mutations(fixture.events.slice(before))).toEqual([]);
        }),
      { timeout: 10_000 },
    );
  }
});
