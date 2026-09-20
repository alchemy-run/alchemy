import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { scratchStack, withProviders } from "@/Test/Core";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import {
  assertBarrierInventory,
  assertClean,
  assertConverged,
  assertSingleRunner,
  census,
  deploy,
  evidencePaths,
  heldLeases,
  identity,
  machine,
  matchesBarrier,
  nowSeconds,
  observeLeaseExpiry,
  persistedRow,
  phases,
  processDeathFile,
  readWitness,
  writeEvidence,
  type Phase,
  type Witness,
} from "./fixtures/process-death.ts";
import { throughProxy, transportProxy } from "./fixtures/transport.ts";

const options = {
  providers: Fly.providers(),
  profile: "testing",
  dev: false,
  sidecar: false,
};
const { test } = Test.make(options);
const selected = process.env.FLY_PROCESS_DEATH_CASE;

const crash = (stack: Test.ScratchStack, title: string, phase: Phase) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* evidencePaths(stack);
    // Invalidate an earlier attempt before any cleanup or new cloud work.
    for (const file of [paths.witness, paths.finalized, paths.recovered]) {
      yield* fs.remove(file, { force: true });
    }
    yield* stack.destroy();
    const initial = yield* deploy(stack, "one").pipe(Effect.scoped);
    expect(initial.machineIds).toHaveLength(1);
    const predecessor = yield* identity(
      yield* machine(initial.appName, initial.machineId),
      stack,
    );
    expect(predecessor.phase).toBe("active");
    const proxy = yield* transportProxy();
    const actor = yield* Effect.sync(() =>
      scratchStack(
        {
          ...options,
          providers: throughProxy(() => proxy.url),
          stage: stack.stage,
        },
        title,
        processDeathFile,
      ),
    );
    expect(actor.name).toBe(stack.name);
    expect(actor.stage).toBe(stack.stage);
    expect(actor.state).not.toBe(stack.state);
    const match = (event: Parameters<typeof matchesBarrier>[3]) =>
      matchesBarrier(phase, initial.appName, predecessor.id, event);
    yield* Effect.sync(() =>
      proxy.arm({ match, action: "hold-response", remaining: 1 }),
    );
    const pid = yield* Effect.sync(() => process.pid);
    // Ordinary failure/interruption invalidates the attempt; SIGKILL cannot run this.
    yield* Effect.addFinalizer(() =>
      writeEvidence(paths.finalized, { pid, phase }).pipe(Effect.orDie),
    );
    const attempt = yield* deploy(actor, "two").pipe(
      Effect.scoped,
      Effect.forkScoped,
    );
    yield* Effect.gen(function* () {
      const barrier = yield* proxy.wait(
        (event) =>
          event.stage === "held" &&
          event.status !== undefined &&
          event.status >= 200 &&
          event.status < 300 &&
          match(event),
      );
      yield* Effect.gen(function* () {
        const live = yield* census(initial.appName);
        const candidates = live.filter((value) => value.id !== predecessor.id);
        expect(candidates).toHaveLength(1);
        const candidate = yield* identity(
          yield* machine(initial.appName, candidates[0]!.id!),
          stack,
        );
        expect(candidate.generation).not.toBe(predecessor.generation);
        expect(candidate.workload).not.toBe(predecessor.workload);
        expect(Number(candidate.sequence)).toBe(
          Number(predecessor.sequence) + 1,
        );
        expect(candidate.instance).toBe(predecessor.instance);
        expect(candidate.fqn).toBe(predecessor.fqn);
        expect(barrier.machineId).toBe(
          phase === "retirement" ? predecessor.id : candidate.id,
        );
        const leases = yield* heldLeases(
          initial.appName,
          live.map((value) => value.id!),
        );
        expect(leases.map((value) => value.machineId).sort()).toEqual(
          (phase === "create"
            ? [predecessor.id]
            : phase === "promotion"
              ? [predecessor.id, candidate.id]
              : [candidate.id]
          ).sort(),
        );
        for (const held of leases) {
          expect(
            proxy.events.some(
              (event) =>
                event.stage === "completed" &&
                event.method === "POST" &&
                event.path.endsWith(`/machines/${held.machineId}/lease`) &&
                event.status !== undefined &&
                event.status >= 200 &&
                event.status < 300,
            ),
          ).toBe(true);
        }
        const row = yield* persistedRow(stack, candidate.fqn);
        expect(row.instanceId).toBe(candidate.instance);
        expect(row.status).toBe("updating");
        const witness = {
          version: 1,
          signal: "SIGKILL",
          phase,
          pid,
          cwd: paths.cwd,
          stack: stack.name,
          stage: stack.stage,
          appName: initial.appName,
          recordedAt: yield* nowSeconds,
          predecessor,
          candidate,
          barrier: {
            sequence: barrier.sequence,
            method: barrier.method,
            path: barrier.path,
            status: barrier.status!,
            machineId: barrier.machineId!,
          },
          leases,
          row,
        } satisfies Witness;
        yield* assertBarrierInventory(stack, witness);
        yield* writeEvidence(paths.witness, witness);
        expect(yield* readWitness(paths.witness)).toEqual(witness);
        yield* Effect.sync(() => {
          expect(attempt.pollUnsafe() === undefined).toBe(true);
          expect(
            proxy.events.some(
              (event) =>
                event.sequence === barrier.sequence &&
                ["forwarded", "dropped"].includes(event.stage),
            ),
          ).toBe(false);
          expect(
            proxy.events.some(
              (event) =>
                event.method === "DELETE" && event.path.endsWith("/lease"),
            ),
          ).toBe(false);
          expect(
            proxy.events.some(
              (event) =>
                event.stage === "request" &&
                event.sequence > barrier.sequence &&
                event.method !== "GET" &&
                !event.path.endsWith("/lease"),
            ),
          ).toBe(false);
          expect(process.pid).toBe(witness.pid);
          process.kill(process.pid, "SIGKILL");
        });
        return yield* Effect.fail(
          new Error("SIGKILL returned without terminating the sole runner"),
        );
      }).pipe(Effect.timeout("20 seconds"));
    }).pipe(
      Effect.raceFirst(
        Fiber.join(attempt).pipe(
          Effect.andThen(
            Effect.fail(
              new Error("Rollout finished before the process-death barrier"),
            ),
          ),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          proxy.clear();
          proxy.release();
        }),
      ),
    );
  }).pipe(Effect.scoped);

const recover = (stack: Test.ScratchStack, phase: Phase) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* evidencePaths(stack);
    const witness = yield* readWitness(paths.witness);
    const pid = yield* Effect.sync(() => process.pid);
    expect(witness.pid).toBeGreaterThan(0);
    expect(pid).not.toBe(witness.pid);
    expect(witness.phase).toBe(phase);
    expect(witness.cwd).toBe(paths.cwd);
    expect(witness.stack).toBe(stack.name);
    expect(witness.stage).toBe(stack.stage);
    expect(yield* fs.exists(paths.finalized)).toBe(false);
    expect(yield* fs.exists(paths.recovered)).toBe(false);
    expect(witness.barrier.status).toBeGreaterThanOrEqual(200);
    expect(witness.barrier.status).toBeLessThan(300);
    expect(witness.barrier.sequence).toBeGreaterThan(0);
    expect(
      matchesBarrier(phase, witness.appName, witness.predecessor.id, {
        ...witness.barrier,
        stage: "held",
      }),
    ).toBe(true);
    expect(witness.barrier.machineId).toBe(
      phase === "retirement" ? witness.predecessor.id : witness.candidate.id,
    );
    expect(yield* persistedRow(stack, witness.row.fqn)).toEqual(witness.row);
    expect(witness.row.status).toBe("updating");
    // No deploy, destroy, lease acquisition or release precedes the expiry observations.
    yield* assertBarrierInventory(stack, witness);
    const expiry = yield* observeLeaseExpiry(witness);
    yield* assertBarrierInventory(stack, witness);
    const recovered = yield* deploy(stack, "two").pipe(Effect.scoped);
    expect(recovered.appName).toBe(witness.appName);
    yield* assertConverged(stack, witness, recovered.machineIds);
    const unchanged = yield* deploy(stack, "two").pipe(Effect.scoped);
    expect(unchanged.machineIds).toEqual(recovered.machineIds);
    yield* assertConverged(stack, witness, unchanged.machineIds);
    yield* stack.destroy();
    yield* assertClean(stack, witness.appName);
    yield* writeEvidence(paths.recovered, {
      phase,
      crashPid: witness.pid,
      recoveryPid: pid,
      barrier: witness.barrier,
      expiry,
      machineIds: recovered.machineIds,
      generation: witness.candidate.generation,
      digest: witness.candidate.digest,
      cleaned: true,
    });
  });

for (const phase of phases) {
  const title = `${phase === "create" ? "F07" : phase === "promotion" ? "F08" : "F09"} F10 process death at completed ${phase}`;
  const skip =
    selected === undefined ||
    (phases.some((value) => value === selected) && selected !== phase);
  if (skip) {
    it.live.skip(title, () => Effect.void);
    continue;
  }
  // test.provider installs unconditional destroy-on-failure; preserve invalid recovery evidence instead.
  test(
    title,
    Effect.gen(function* () {
      yield* assertSingleRunner;
      expect(selected).toBe(phase);
      const mode = process.env.FLY_PROCESS_DEATH_MODE;
      if (mode !== "crash" && mode !== "recovery") {
        return yield* Effect.fail(
          new Error("FLY_PROCESS_DEATH_MODE must be crash or recovery"),
        );
      }
      const stack = yield* Effect.sync(() =>
        scratchStack(options, title, processDeathFile),
      );
      yield* withProviders(
        mode === "crash" ? crash(stack, title, phase) : recover(stack, phase),
        options,
        stack.name,
      );
    }).pipe(Effect.scoped),
    { timeout: 500_000, retry: 0, exclusive: true },
  );
}
