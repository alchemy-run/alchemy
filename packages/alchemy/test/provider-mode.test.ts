/**
 * First-class local vs live provider modes.
 *
 * Covers the engine behavior added by ProviderMode / ProviderLayer.dual:
 *   - the resolved mode is stamped on state (`providerMode`) on every commit
 *   - dev runs resolve local providers; `remote()` opts a resource out of
 *     local emulation; mode-agnostic providers satisfy any requested mode
 *   - switching modes plans a REPLACEMENT; the old generation / orphan row
 *     is deleted with the provider variant of the mode that created it
 *   - providers may opt into an in-place handoff that preserves physical
 *     identity and deactivates the outgoing runtime without deleting it
 *   - unstamped rows are assumed to be the current run's mode
 *   - conflicting mode decorations on the same FQN die loudly
 *   - the non-default variant is only constructed when demanded (laziness)
 *
 * Also unit-tests the LocalProvider.make lifecycle (config-hash noop/restart,
 * instanceId-guarded delete, invalidate, stop hook) by driving the generated
 * provider service directly.
 */
import * as LocalProvider from "@/Local/LocalProvider.ts";
import * as Provider from "@/Provider.ts";
import { remote } from "@/ProviderMode.ts";
import { Resource } from "@/Resource";
import { Stack } from "@/Stack";
import { State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  Bucket,
  InPlaceModalResource,
  inDev,
  inPlaceModalCalls,
  ModalResource,
  modalBuilds,
  modalCalls,
  TestLayers,
} from "./test.resources.ts";

const { test } = Test.make({ providers: TestLayers() });

const getState = Effect.fn(function* (fqn: string) {
  const state = yield* yield* State;
  const stk = yield* Stack;
  return (yield* state.get({
    stack: stk.name,
    stage: stk.stage,
    fqn,
  })) as ResourceState | undefined;
});

const setState = Effect.fn(function* (fqn: string, value: ResourceState) {
  const state = yield* yield* State;
  const stk = yield* Stack;
  yield* state.set({ stack: stk.name, stage: stk.stage, fqn, value });
});

const modal = (id: string, value?: string) =>
  Effect.gen(function* () {
    const a = yield* ModalResource(id, { value });
    return { runtime: a.runtime };
  });

const inPlaceModal = (id: string, value?: string) =>
  Effect.gen(function* () {
    return yield* InPlaceModalResource(id, { value });
  });

const callsFor = (stackName: string) =>
  modalCalls.filter((c) => c.stack === stackName);
const buildsFor = (stackName: string) =>
  modalBuilds.filter((b) => b.stack === stackName);

describe("provider modes", () => {
  test.provider(
    "default mode is live; providerMode is stamped; local variant is never built",
    (stack) =>
      Effect.gen(function* () {
        const output = yield* modal("A", "v1").pipe(stack.deploy);
        expect(output.runtime).toEqual("live");

        const state = yield* getState("A");
        expect(state?.status).toEqual("created");
        expect(state?.providerMode).toEqual("live");

        // Laziness: nothing demanded the local variant in a live-default
        // run, so it must never have been constructed.
        expect(
          buildsFor(stack.name).filter((b) => b.mode === "local"),
        ).toHaveLength(0);
        expect(
          buildsFor(stack.name).filter((b) => b.mode === "live").length,
        ).toBeGreaterThan(0);

        yield* stack.destroy();
      }),
  );

  test.provider(
    "a dev run resolves the local provider; live-only resources stay live",
    (stack) =>
      Effect.gen(function* () {
        const output = yield* inDev(modal("A", "v1").pipe(stack.deploy));
        expect(output.runtime).toEqual("local");
        expect((yield* getState("A"))?.providerMode).toEqual("local");

        // A mode-agnostic resource in the same dev run deploys with its
        // single implementation and stays unstamped — constructs mixing
        // emulatable and live-only resources just work.
        yield* inDev(
          Effect.gen(function* () {
            yield* ModalResource("A", { value: "v1" });
            yield* Bucket("B", {});
            return {};
          }).pipe(stack.deploy),
        );
        expect((yield* getState("B"))?.providerMode).toBeUndefined();

        yield* stack.destroy();
      }),
  );

  test.provider(
    "remote() opts a resource out of local emulation during dev",
    (stack) =>
      Effect.gen(function* () {
        const output = yield* inDev(
          modal("A", "v1").pipe(remote(), stack.deploy),
        );
        expect(output.runtime).toEqual("live");
        expect((yield* getState("A"))?.providerMode).toEqual("live");

        // Dropping remote() in a later dev run switches it back to local —
        // a replacement like any other mode switch.
        const back = yield* inDev(modal("A", "v1").pipe(stack.deploy));
        expect(back.runtime).toEqual("local");
        expect((yield* getState("A"))?.providerMode).toEqual("local");

        yield* stack.destroy();
      }),
  );

  test.provider(
    "switching modes replaces: new mode creates, old mode deletes",
    (stack) =>
      Effect.gen(function* () {
        // 1. dev run: local instance.
        yield* inDev(modal("A", "v1").pipe(stack.deploy));
        expect((yield* getState("A"))?.providerMode).toEqual("local");
        const localInstanceId = (yield* getState("A"))?.instanceId;

        // 2. same props, deploy (live) run → the plan must be a
        //    replacement even though nothing about the props changed.
        const plan = yield* modal("A", "v1").pipe(stack.plan);
        expect(plan.resources["A"].action).toEqual("replace");

        // 3. apply: the live variant reconciles the new generation, the
        //    LOCAL variant (the mode that created it) deletes the old one.
        const before = callsFor(stack.name).length;
        const output = yield* modal("A", "v1").pipe(stack.deploy);
        expect(output.runtime).toEqual("live");

        const state = yield* getState("A");
        expect(state?.status).toEqual("created");
        expect(state?.providerMode).toEqual("live");
        expect(state?.instanceId).not.toEqual(localInstanceId);

        const calls = callsFor(stack.name).slice(before);
        expect(calls).toContainEqual({
          stack: stack.name,
          mode: "live",
          op: "reconcile",
          id: "A",
        });
        expect(calls).toContainEqual({
          stack: stack.name,
          mode: "local",
          op: "delete",
          id: "A",
        });

        // 4. switch back: live → local replaces again, deleted by LIVE.
        const beforeBack = callsFor(stack.name).length;
        const back = yield* inDev(modal("A", "v1").pipe(stack.deploy));
        expect(back.runtime).toEqual("local");
        expect((yield* getState("A"))?.providerMode).toEqual("local");
        expect(callsFor(stack.name).slice(beforeBack)).toContainEqual({
          stack: stack.name,
          mode: "live",
          op: "delete",
          id: "A",
        });

        yield* stack.destroy();
      }),
  );

  test.provider(
    "an in-place mode switch preserves identity and deactivates the outgoing provider",
    (stack) =>
      Effect.gen(function* () {
        const live = yield* inPlaceModal("A", "v1").pipe(stack.deploy);
        const initialState = yield* getState("A");
        expect(initialState?.providerMode).toEqual("live");

        const localPlan = yield* inDev(
          inPlaceModal("A", "v1").pipe(stack.plan),
        );
        expect(localPlan.resources["A"].action).toEqual("update");

        const beforeLocal = inPlaceModalCalls.length;
        const local = yield* inDev(inPlaceModal("A", "v1").pipe(stack.deploy));
        const localState = yield* getState("A");
        expect(local.runtime).toEqual("local");
        expect(local.physicalId).toEqual(live.physicalId);
        expect(localState?.instanceId).toEqual(initialState?.instanceId);
        expect(localState?.providerMode).toEqual("local");
        expect(inPlaceModalCalls.slice(beforeLocal)).toEqual([
          {
            stack: stack.name,
            mode: "live",
            op: "deactivate",
            id: "A",
            instanceId: initialState?.instanceId,
            physicalId: live.physicalId,
          },
          {
            stack: stack.name,
            mode: "local",
            op: "reconcile",
            id: "A",
            instanceId: initialState?.instanceId,
            physicalId: live.physicalId,
          },
        ]);

        const beforeLive = inPlaceModalCalls.length;
        const restored = yield* inPlaceModal("A", "v1").pipe(stack.deploy);
        const restoredState = yield* getState("A");
        expect(restored.runtime).toEqual("live");
        expect(restored.physicalId).toEqual(live.physicalId);
        expect(restoredState?.instanceId).toEqual(initialState?.instanceId);
        expect(restoredState?.providerMode).toEqual("live");
        expect(inPlaceModalCalls.slice(beforeLive)).toEqual([
          {
            stack: stack.name,
            mode: "local",
            op: "deactivate",
            id: "A",
            instanceId: initialState?.instanceId,
            physicalId: live.physicalId,
          },
          {
            stack: stack.name,
            mode: "live",
            op: "reconcile",
            id: "A",
            instanceId: initialState?.instanceId,
            physicalId: live.physicalId,
          },
        ]);

        yield* stack.destroy();
      }),
  );

  test.provider(
    "an orphaned local row is deleted by the local provider during a live run",
    (stack) =>
      Effect.gen(function* () {
        yield* inDev(modal("A", "v1").pipe(stack.deploy));

        // Remove the resource from the program and deploy in (default)
        // live mode — the orphan delete must still route to the LOCAL
        // variant, since that's the mode that created the row.
        const before = callsFor(stack.name).length;
        yield* Effect.succeed({}).pipe(stack.deploy);

        expect(yield* getState("A")).toBeUndefined();
        expect(callsFor(stack.name).slice(before)).toContainEqual({
          stack: stack.name,
          mode: "local",
          op: "delete",
          id: "A",
        });
      }),
  );

  test.provider(
    "unstamped (legacy) rows are assumed to be the current run's mode",
    (stack) =>
      Effect.gen(function* () {
        yield* modal("A", "v1").pipe(stack.deploy);
        const row = yield* getState("A");
        expect(row?.providerMode).toEqual("live");

        // Simulate a row written before providerMode existed.
        yield* setState("A", { ...row!, providerMode: undefined });

        // Same mode (default live) → no replacement churn.
        const plan = yield* modal("A", "v1").pipe(stack.plan);
        expect(plan.resources["A"].action).toEqual("noop");

        yield* stack.destroy();
      }),
  );

  test.provider(
    "mode-agnostic providers never replace on a mode switch",
    (stack) =>
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          yield* Bucket("B", {});
          return {};
        });
        yield* inDev(program.pipe(stack.deploy));
        expect((yield* getState("B"))?.providerMode).toBeUndefined();

        const plan = yield* program.pipe(stack.plan);
        expect(plan.resources["B"].action).toEqual("noop");

        yield* stack.destroy();
      }),
  );

  test.provider(
    "conflicting mode decorations on the same resource die",
    (stack) =>
      Effect.gen(function* () {
        const exit = yield* Effect.gen(function* () {
          yield* ModalResource("A", { value: "v1" });
          yield* ModalResource("A", { value: "v1" }).pipe(remote());
          return {};
        }).pipe(stack.deploy, Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const defects = exit.cause.reasons.flatMap((reason) =>
            reason._tag === "Die" ? [reason.defect as any] : [],
          );
          expect(
            defects.some((d) => d?._tag === "ConflictingProviderModeError"),
          ).toBe(true);
        }

        // Re-registering WITHOUT an explicit ambient mode inherits the
        // original registration — the common "reference it from elsewhere"
        // pattern must keep working.
        const output = yield* inDev(
          Effect.gen(function* () {
            yield* ModalResource("A", { value: "v1" }).pipe(remote());
            const again = yield* ModalResource("A", { value: "v1" });
            return { runtime: again.runtime };
          }).pipe(stack.deploy),
        );
        expect(output.runtime).toEqual("live");

        yield* stack.destroy();
      }),
  );
});

// ── LocalProvider.make lifecycle ────────────────────────────────────────────
//
// Drives the generated provider service directly (no engine) so noop /
// restart / delete semantics are observable across sequential calls against
// ONE provider instance — scratch deploys rebuild providers per deploy, which
// would reset the in-memory instance registry between steps.

interface LocalThing extends Resource<
  "Test.LocalThing",
  { value?: string; ignored?: string },
  { value: string }
> {}
const LocalThing = Resource<LocalThing>("Test.LocalThing");

const localThingEvents: string[] = [];
let capturedInvalidate: Effect.Effect<void> | undefined;

type LocalThingConfig = { value: string | undefined };

const localThingProvider = () =>
  LocalProvider.make(
    LocalThing,
    import.meta.url, // unused: no RpcProviderProxy in tests → in-process
    Effect.gen(function* () {
      return {
        // `ignored` is excluded from the restart-relevant config: changing
        // it must NOT restart the instance.
        resolveConfig: ({
          news,
        }: LocalProvider.LocalProviderInput<LocalThing>) =>
          Effect.succeed<LocalThingConfig>({ value: news?.value }),
        start: Effect.fn(function* ({
          id,
          config,
          invalidate,
        }: LocalProvider.StartContext<LocalThing, LocalThingConfig>) {
          localThingEvents.push(`start:${id}:${config.value ?? ""}`);
          capturedInvalidate = invalidate;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              localThingEvents.push(`kill:${id}`);
            }),
          );
          return { value: config.value ?? id };
        }),
        deactivate: ({ id }: LocalProvider.DeactivateContext) =>
          Effect.sync(() => {
            localThingEvents.push(`deactivate:${id}`);
          }),
        stop: ({ id }: LocalProvider.StopContext) =>
          Effect.sync(() => {
            localThingEvents.push(`stop:${id}`);
          }),
      };
    }),
  );

const fakeSession = {
  note: () => Effect.void,
  emit: () => Effect.void,
} as any;

const lifecycleInput = (instanceId: string, news: LocalThing["Props"]) => ({
  id: "A",
  fqn: "A",
  instanceId,
  news,
  // The generated diff/reconcile never consult olds — the running instance's
  // recorded config is the baseline (state can't know if the process lives).
  olds: {} as LocalThing["Props"],
  output: undefined,
  oldBindings: [] as any[],
  newBindings: [] as any[],
  bindings: [] as any[],
  session: fakeSession,
});

test(
  "LocalProvider.make: config-hash restart, deactivate, guarded delete, invalidate, stop",
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(LocalThing);
    localThingEvents.length = 0;

    // create
    const attrs1 = yield* provider.reconcile(
      lifecycleInput("i1", {
        value: "v1",
      }),
    );
    expect(attrs1).toEqual({ value: "v1" });
    expect(localThingEvents).toEqual(["start:A:v1"]);

    // same config → diff noop, reconcile joins the running instance
    expect(
      yield* provider.diff!(lifecycleInput("i1", { value: "v1" })),
    ).toEqual({ action: "noop" });
    yield* provider.reconcile(lifecycleInput("i1", { value: "v1" }));
    expect(localThingEvents).toEqual(["start:A:v1"]);

    // config change that normalizes away (`ignored` not in resolveConfig)
    // → still a noop
    expect(
      yield* provider.diff!(
        lifecycleInput("i1", { value: "v1", ignored: "x" }),
      ),
    ).toEqual({ action: "noop" });

    // real config change → update; reconcile kills then restarts
    expect(
      yield* provider.diff!(lifecycleInput("i1", { value: "v2" })),
    ).toEqual({ action: "update" });
    yield* provider.reconcile(lifecycleInput("i1", { value: "v2" }));
    expect(localThingEvents).toEqual(["start:A:v1", "kill:A", "start:A:v2"]);

    // In-place provider handoff tears down only the local runtime. It does
    // not run the physical-resource stop hook.
    yield* provider.deactivate!(lifecycleInput("i1", { value: "v2" }) as any);
    expect(localThingEvents.slice(-2)).toEqual(["kill:A", "deactivate:A"]);
    yield* provider.reconcile(lifecycleInput("i1", { value: "v2" }));

    // delete with a STALE instanceId (replacement ordering) must not touch
    // the running instance nor run `stop`
    yield* provider.delete(lifecycleInput("i0", { value: "v2" }) as any);
    expect(localThingEvents).toEqual(["start:A:v1", "kill:A", "start:A:v2"]);

    // invalidate (process died on its own) → next diff is an update
    yield* capturedInvalidate!;
    expect(
      yield* provider.diff!(lifecycleInput("i1", { value: "v2" })),
    ).toEqual({ action: "update" });
    yield* provider.reconcile(lifecycleInput("i1", { value: "v2" }));

    // matching delete tears down, deactivates local state, then runs stop
    yield* provider.delete(lifecycleInput("i1", { value: "v2" }) as any);
    expect(localThingEvents.slice(-3)).toEqual([
      "kill:A",
      "deactivate:A",
      "stop:A",
    ]);

    // idempotent: deleting again re-runs the idempotent cleanup hooks
    yield* provider.delete(lifecycleInput("i1", { value: "v2" }) as any);
    expect(localThingEvents.slice(-2)).toEqual(["deactivate:A", "stop:A"]);
  }).pipe(
    Effect.provide(localThingProvider()),
    Effect.provide(
      Layer.succeed(Stack, {
        name: "local-provider-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
    ),
  ),
);
