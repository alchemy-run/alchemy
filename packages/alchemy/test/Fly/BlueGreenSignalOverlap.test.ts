import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { scratchStack, withProviders } from "@/Test/Core";
import { expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import {
  assertClean,
  census,
  deploy,
  heldLeases,
  identity,
  machine,
  nowSeconds,
  persistedRow,
  writeEvidence,
} from "./fixtures/process-death.ts";
import {
  Finalized,
  RunnerInterrupted,
  Witness,
  assertBoundary,
  assertConverged,
  assertInventory,
  assertReleased,
  assertSingleRunner,
  boundary,
  cases,
  firstReturnedUncordon,
  matches,
  observeExpiry,
  observeLeases,
  pathsFor,
  readEvidence,
  signalOverlapFile,
  successful,
  type SignalCase,
} from "./fixtures/signal-overlap.ts";
import { throughProxy, transportProxy } from "./fixtures/transport.ts";

const options = {
  providers: Fly.providers(),
  profile: "testing",
  dev: false,
  sidecar: false,
};
const { test, beforeEach, afterEach } = Test.make(options);
const selected = process.env.FLY_SIGNAL_OVERLAP_CASE;
let signaled:
  | {
      witness: Witness;
      paths: Effect.Success<ReturnType<typeof pathsFor>>;
    }
  | undefined;

// Observe the runner's own teardown; never bridge SIGINT into a manual fiber interrupt.
afterEach(
  Effect.gen(function* () {
    if (!signaled || signaled.witness.signal !== "SIGINT") return;
    const { witness, paths } = signaled;
    const fs = yield* FileSystem.FileSystem;
    yield* writeEvidence(paths.runnerInterrupted, {
      pid: yield* Effect.sync(() => process.pid),
      case: witness.case,
      signal: "SIGINT",
      witnessRecordedAt: witness.recordedAt,
      at: yield* nowSeconds,
      deployFinalized: yield* fs.exists(paths.finalized),
    } satisfies typeof RunnerInterrupted.Type);
  }),
  { timeout: 30_000 },
);

const crash = (
  stack: Test.ScratchStack,
  title: string,
  selectedCase: SignalCase,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* pathsFor(stack);
    // Never erase an incomplete signal attempt to make a retry green.
    if (
      (yield* fs.exists(paths.witness)) &&
      !(yield* fs.exists(paths.recovered))
    ) {
      return yield* Effect.fail(
        new Error(
          "An unrecovered signal witness exists; preserve it and use the recovery leg",
        ),
      );
    }
    for (const file of [
      paths.witness,
      paths.finalized,
      paths.runnerInterrupted,
      paths.blocked,
      paths.recovered,
    ]) {
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
        signalOverlapFile,
      ),
    );
    expect(actor.name).toBe(stack.name);
    expect(actor.stage).toBe(stack.stage);
    expect(actor.state).not.toBe(stack.state);
    const match = (event: Parameters<typeof matches>[4]) =>
      matches(
        selectedCase.phase,
        initial.appName,
        predecessor.id,
        proxy.events,
        event,
      );
    yield* Effect.sync(() =>
      proxy.arm({ match, action: "hold-response", remaining: 1 }),
    );
    const pid = yield* Effect.sync(() => process.pid);
    let armed: Witness | undefined;
    const attempt = yield* deploy(actor, "two").pipe(
      Effect.scoped,
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (!armed) {
            yield* writeEvidence(paths.finalized, {
              pid,
              case: selectedCase.name,
              armed: false,
            });
            return;
          }
          // The deploy scope has closed, including native lease-release finalizers.
          const leases = yield* observeLeases(armed);
          const releases = yield* Effect.sync(() =>
            proxy.events
              .filter(
                (event) =>
                  event.stage === "completed" &&
                  event.sequence > armed!.barrier.sequence &&
                  event.method === "DELETE" &&
                  event.path.endsWith("/lease") &&
                  successful(event),
              )
              .map(boundary),
          );
          yield* writeEvidence(paths.finalized, {
            pid,
            case: selectedCase.name,
            witnessRecordedAt: armed.recordedAt,
            interruptedOnly:
              Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
            at: yield* nowSeconds,
            releases,
            leases,
          } satisfies typeof Finalized.Type);
        }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.gen(function* () {
      const barrier = yield* proxy.wait(
        (event) => event.stage === "held" && successful(event) && match(event),
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
        const leases = yield* heldLeases(
          initial.appName,
          live.map((value) => value.id!),
        );
        expect(leases.map((value) => value.machineId).sort()).toEqual(
          (selectedCase.phase === "create"
            ? [predecessor.id]
            : selectedCase.phase === "retirement"
              ? [candidate.id]
              : [predecessor.id, candidate.id]
          ).sort(),
        );
        for (const held of leases) {
          expect(
            proxy.events.some(
              (event) =>
                event.stage === "completed" &&
                event.method === "POST" &&
                event.path.endsWith(`/machines/${held.machineId}/lease`) &&
                successful(event),
            ),
          ).toBe(true);
        }
        const row = yield* persistedRow(stack, candidate.fqn);
        expect(row.instanceId).toBe(candidate.instance);
        expect(row.status).toBe("updating");
        const returned = firstReturnedUncordon(proxy.events, initial.appName);
        const witness = {
          version: 1,
          case: selectedCase.name,
          signal: selectedCase.signal,
          phase: selectedCase.phase,
          pid,
          cwd: paths.cwd,
          stack: stack.name,
          stage: stack.stage,
          appName: initial.appName,
          recordedAt: yield* nowSeconds,
          predecessor,
          candidate,
          barrier: boundary(barrier),
          ...(selectedCase.phase === "overlap"
            ? { returnedUncordon: boundary(returned!) }
            : {}),
          leases,
          row,
        } satisfies Witness;
        yield* assertBoundary(witness);
        yield* assertInventory(stack, witness);
        yield* writeEvidence(paths.witness, witness);
        expect(yield* readEvidence(paths.witness, Witness)).toEqual(witness);
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
          if (selectedCase.phase === "overlap") {
            expect(returned).toBeDefined();
            expect(
              proxy.events.filter(
                (event) =>
                  event.stage === "forwarded" &&
                  event.path.endsWith("/uncordon"),
              ),
            ).toHaveLength(1);
            expect(
              proxy.events.some(
                (event) =>
                  event.sequence === returned!.sequence &&
                  ["held", "dropped"].includes(event.stage),
              ),
            ).toBe(false);
            expect(
              proxy.events.some(
                (event) =>
                  event.stage === "request" && event.path.endsWith("/cordon"),
              ),
            ).toBe(false);
            expect(
              proxy.events.some(
                (event) =>
                  event.stage === "request" &&
                  event.sequence === barrier.sequence &&
                  event.method === "GET" &&
                  event.machineId === candidate.id,
              ),
            ).toBe(true);
          }
          if (selectedCase.signal === "SIGINT") {
            expect(process.listenerCount("SIGINT")).toBeGreaterThan(0);
          }
          expect(process.pid).toBe(witness.pid);
          armed = witness;
          signaled = { witness, paths };
          process.kill(process.pid, selectedCase.signal);
        });
        if (selectedCase.signal === "SIGKILL") {
          return yield* Effect.fail(
            new Error("SIGKILL did not terminate the sole runner"),
          );
        }
      }).pipe(Effect.timeout("20 seconds"));
      // Only the runner may interrupt the deploy; the held response stays held.
      return yield* Effect.never;
    }).pipe(
      Effect.raceFirst(
        Fiber.join(attempt).pipe(
          Effect.andThen(
            Effect.fail(
              new Error(
                "Rollout completed instead of terminating at the signal barrier",
              ),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped);

const recover = (stack: Test.ScratchStack, selectedCase: SignalCase) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* pathsFor(stack);
    const witness = yield* readEvidence(paths.witness, Witness);
    const pid = yield* Effect.sync(() => process.pid);
    expect(witness.pid).toBeGreaterThan(0);
    expect(pid).not.toBe(witness.pid);
    expect(witness.case).toBe(selectedCase.name);
    expect(witness.signal).toBe(selectedCase.signal);
    expect(witness.phase).toBe(selectedCase.phase);
    expect(witness.cwd).toBe(paths.cwd);
    expect(witness.stack).toBe(stack.name);
    expect(witness.stage).toBe(stack.stage);
    expect(yield* fs.exists(paths.recovered)).toBe(false);
    yield* assertBoundary(witness);
    expect(yield* persistedRow(stack, witness.row.fqn)).toEqual(witness.row);
    expect(witness.row.status).toBe("updating");
    yield* assertInventory(stack, witness);
    // No deploy, destroy, acquire or release can manufacture either lease proof.
    const authority = yield* Effect.gen(function* () {
      if (selectedCase.signal === "SIGKILL") {
        expect(yield* fs.exists(paths.finalized)).toBe(false);
        expect(yield* fs.exists(paths.runnerInterrupted)).toBe(false);
        return { mode: "expiry", evidence: yield* observeExpiry(witness) };
      }
      const runner = yield* readEvidence(
        paths.runnerInterrupted,
        RunnerInterrupted,
      );
      expect(runner.pid).toBe(witness.pid);
      expect(runner.case).toBe(witness.case);
      expect(runner.witnessRecordedAt).toBe(witness.recordedAt);
      expect(runner.at).toBeGreaterThanOrEqual(witness.recordedAt);
      if (!(yield* fs.exists(paths.finalized))) {
        yield* writeEvidence(paths.blocked, {
          case: witness.case,
          crashPid: witness.pid,
          recoveryPid: pid,
          runner,
          leases: yield* observeLeases(witness),
          nativeFinalizerProved: false,
          recovered: false,
        });
        return yield* Effect.fail(
          new Error(
            "SIGINT reached runner teardown but the scoped deploy did not finalize; native lease RELEASE is unproved. Preserve this attempt; expiry is not SIGINT acceptance.",
          ),
        );
      }
      expect(runner.deployFinalized).toBe(true);
      const finalized = yield* readEvidence(paths.finalized, Finalized);
      return {
        mode: "release",
        runner,
        evidence: yield* assertReleased(witness, finalized),
      };
    });
    yield* assertInventory(stack, witness);
    const recovered = yield* deploy(stack, "two").pipe(Effect.scoped);
    expect(recovered.appName).toBe(witness.appName);
    yield* assertConverged(stack, witness, recovered.machineIds);
    const unchanged = yield* deploy(stack, "two").pipe(Effect.scoped);
    expect(unchanged.machineIds).toEqual(recovered.machineIds);
    yield* assertConverged(stack, witness, unchanged.machineIds);
    yield* stack.destroy();
    yield* assertClean(stack, witness.appName);
    yield* writeEvidence(paths.recovered, {
      case: witness.case,
      signal: witness.signal,
      phase: witness.phase,
      crashPid: witness.pid,
      recoveryPid: pid,
      barrier: witness.barrier,
      returnedUncordon: witness.returnedUncordon,
      authority,
      machineIds: recovered.machineIds,
      generation: witness.candidate.generation,
      digest: witness.candidate.digest,
      cleaned: true,
    });
  });

const titleFor = (selectedCase: SignalCase) =>
  `F10 deployer ${selectedCase.signal} at ${selectedCase.phase}`;

// Runner bodies are detached; ordinary setup hooks remain attached to runMain.
beforeEach(
  Effect.gen(function* () {
    if (process.env.FLY_SIGNAL_OVERLAP_MODE !== "crash") return;
    yield* assertSingleRunner;
    const selectedCase = cases.find((value) => value.name === selected);
    if (!selectedCase) {
      return yield* Effect.fail(new Error("Unknown signal case selector"));
    }
    const title = titleFor(selectedCase);
    const stack = yield* Effect.sync(() =>
      scratchStack(options, title, signalOverlapFile),
    );
    yield* withProviders(
      crash(stack, title, selectedCase),
      options,
      stack.name,
    );
  }).pipe(Effect.scoped),
  { timeout: 750_000 },
);

for (const selectedCase of cases) {
  const title = titleFor(selectedCase);
  const skip =
    selected === undefined ||
    (cases.some((value) => value.name === selected) &&
      selected !== selectedCase.name);
  if (skip) {
    it.live.skip(title, () => Effect.void);
    continue;
  }
  // No destroy-on-failure wrapper: failed recovery must preserve the forensic state.
  test(
    title,
    Effect.gen(function* () {
      yield* assertSingleRunner;
      expect(selected).toBe(selectedCase.name);
      const mode = process.env.FLY_SIGNAL_OVERLAP_MODE;
      if (mode !== "crash" && mode !== "recovery") {
        return yield* Effect.fail(
          new Error("FLY_SIGNAL_OVERLAP_MODE must be crash or recovery"),
        );
      }
      if (mode === "crash") {
        return yield* Effect.fail(
          new Error("The crash setup returned without terminating the runner"),
        );
      }
      const stack = yield* Effect.sync(() =>
        scratchStack(options, title, signalOverlapFile),
      );
      yield* withProviders(recover(stack, selectedCase), options, stack.name);
    }).pipe(Effect.scoped),
    { timeout: 750_000, retry: 0, exclusive: true },
  );
}
