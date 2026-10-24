import { describe, expect } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { Unowned } from "@/AdoptPolicy";
import * as Drift from "@/Drift";
import * as Namespace from "@/Namespace.ts";
import { Progress, type ApplyEvent, type ProgressEvent } from "@/Report.ts";
import { Stack } from "@/Stack";
import { State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import {
  Bucket,
  DriftResource,
  makeTestCloud,
  ResourceFailure,
  TestCloud,
  TestLayers,
  TestResource,
  TestResourceHooks,
  failOn,
  type TestCloudService,
} from "./test.resources.ts";

const { test } = Test.make({ providers: TestLayers() });

const getState = Effect.fn(function* <S = ResourceState>(resourceId: string) {
  const state = yield* yield* State;
  const stk = yield* Stack;
  return (yield* state.get({ stack: stk.name, stage: stk.stage, fqn: resourceId })) as S;
});

const seed = Effect.fn(function* (rows: Record<string, any>) {
  const state = yield* yield* State;
  const stk = yield* Stack;
  for (const [fqn, value] of Object.entries(rows)) {
    yield* state.set({ stack: stk.name, stage: stk.stage, fqn, value });
  }
});

const runDrift = (options: Drift.DriftOptions & { readonly dryRun?: boolean } = {}) =>
  Effect.gen(function* () {
    const stk = yield* Stack;
    const identity = { name: stk.name, stage: stk.stage };
    return yield* options.dryRun
      ? Drift.detect(identity)
      : Drift.repair(identity, { session: options.session });
  });

const withCloud =
  (cloud: TestCloudService) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(Layer.succeed(TestCloud, cloud)));

const reconcileCalls = (cloud: TestCloudService) =>
  cloud.calls.filter((c) => c.op === "reconcile").map((c) => c.id);

// `id[sid,…]` per reconcile, in call order — shows both the order and which
// bindings each reconcile carried.
const reconcileTrace = (cloud: TestCloudService) =>
  cloud.calls
    .filter((c) => c.op === "reconcile")
    .map((c) => `${c.id}[${(c.bindings ?? []).join(",")}]`);

const statusesOf = (events: ApplyEvent[], fqn: string) =>
  events.flatMap((e) => (e._tag === "apply.resource.status" && e.fqn === fqn ? [e.status] : []));

const recordingSession = () => {
  const events: ApplyEvent[] = [];
  return {
    events,
    session: {
      emit: (event: ApplyEvent) =>
        Effect.sync(() => {
          events.push(event);
        }),
      done: () => Effect.void,
    },
  };
};

const readCalls = (cloud: TestCloudService) =>
  cloud.calls.filter((c) => c.op === "read").map((c) => c.id);

const instanceId = "852f6ec2e19b66589825efe14dca2971";

describe("drift detection and repair", { tags: ["unit", "local"] }, () => {
  test.provider(
    "clean deployment: every resource is unchanged and reconcile is not invoked",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* DriftResource("A", { value: "a" });
            yield* DriftResource("B", { value: "b" });
          }),
        );

        cloud.calls.length = 0;
        const result = yield* runDrift();

        expect(result.resources).toMatchObject({
          A: { action: "unchanged", resourceType: "Test.DriftResource" },
          B: { action: "unchanged", resourceType: "Test.DriftResource" },
        });
        // drift observed both resources but touched neither
        expect(readCalls(cloud).sort()).toEqual(["A", "B"]);
        expect(reconcileCalls(cloud)).toEqual([]);
        // cloud and state are untouched
        expect(cloud.resources.get("A")).toMatchObject({ value: "a" });
        expect((yield* getState("A"))?.status).toEqual("created");
      }).pipe(withCloud(cloud));
    },
  );

  test.provider("out-of-band value drift is repaired back to the desired state", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));

      // someone edits the resource in the console
      cloud.resources.get("A")!.value = "hijacked";

      cloud.calls.length = 0;
      const result = yield* runDrift();

      expect(result.resources.A).toMatchObject({ action: "repaired", attr: { value: "a" } });
      // cloud converged back to the last-deployed desired state
      expect(cloud.resources.get("A")).toMatchObject({ value: "a" });
      expect(reconcileCalls(cloud)).toEqual(["A"]);
      // state refreshed with the reconciled attributes
      expect(yield* getState("A")).toMatchObject({
        status: "updated",
        attr: { value: "a" },
        props: { value: "a" },
      });
    }).pipe(withCloud(cloud));
  });

  test.provider("nested tag drift is detected and repaired", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a", tags: { team: "alchemy" } }));

      // foreign tags appear and an owned tag is clobbered
      cloud.resources.get("A")!.tags = { team: "intruder", extra: "tag" };

      const result = yield* runDrift();

      expect(result.resources.A?.action).toEqual("repaired");
      expect(cloud.resources.get("A")!.tags).toEqual({ team: "alchemy" });
      expect((yield* getState("A"))?.attr?.tags).toEqual({ team: "alchemy" });
    }).pipe(withCloud(cloud));
  });

  test.provider(
    "a resource deleted out-of-band is recreated under the same instance id",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(DriftResource("A", { value: "a" }));
        const before = yield* getState("A");

        // someone deletes the resource in the console
        cloud.resources.delete("A");

        const result = yield* runDrift();

        expect(result.resources.A).toMatchObject({
          action: "recreated",
          attr: { id: "A", value: "a" },
        });
        expect(cloud.resources.get("A")).toMatchObject({ value: "a" });
        expect(yield* getState("A")).toMatchObject({
          status: "created",
          // same instance id so deterministic physical names converge
          instanceId: before!.instanceId,
          attr: { value: "a" },
        });
      }).pipe(withCloud(cloud));
    },
  );

  test.provider("drift is idempotent", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));
      cloud.resources.get("A")!.value = "hijacked";

      const first = yield* runDrift();
      expect(first.resources.A?.action).toEqual("repaired");

      cloud.calls.length = 0;
      const second = yield* runDrift();
      expect(second.resources.A?.action).toEqual("unchanged");
      expect(reconcileCalls(cloud)).toEqual([]);
    }).pipe(withCloud(cloud));
  });

  test.provider("mixed fleet: only drifted and missing resources are reconciled", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* DriftResource("Clean", { value: "clean" });
          yield* DriftResource("Drifted", { value: "drifted" });
          yield* DriftResource("Missing", { value: "missing" });
        }),
      );

      cloud.resources.get("Drifted")!.value = "hijacked";
      cloud.resources.delete("Missing");

      cloud.calls.length = 0;
      const result = yield* runDrift();

      expect(result.resources).toMatchObject({
        Clean: { action: "unchanged" },
        Drifted: { action: "repaired" },
        Missing: { action: "recreated" },
      });
      expect(reconcileCalls(cloud).sort()).toEqual(["Drifted", "Missing"]);
      expect(cloud.resources.get("Drifted")).toMatchObject({ value: "drifted" });
      expect(cloud.resources.get("Missing")).toMatchObject({ value: "missing" });
    }).pipe(withCloud(cloud));
  });

  test.provider("empty state: drift succeeds with no resources", () =>
    Effect.gen(function* () {
      const result = yield* runDrift();
      expect(result.resources).toEqual({});
    }),
  );

  test.provider("a provider whose read reflects state back never drifts", (stack) =>
    Effect.gen(function* () {
      // TestResource.read returns the persisted output when no hook is
      // installed — the degenerate "cannot observe drift" case.
      yield* stack.deploy(TestResource("A", { string: "test-string" }));
      const result = yield* runDrift();
      expect(result.resources.A?.action).toEqual("unchanged");
    }),
  );
});

describe("dry run", { tags: ["unit", "local"] }, () => {
  test.provider("reports drift without repairing the cloud or touching state", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));
      cloud.resources.get("A")!.value = "hijacked";

      cloud.calls.length = 0;
      const result = yield* runDrift({ dryRun: true });

      expect(result.resources.A).toMatchObject({
        action: "drifted",
        // dry-run reports the OBSERVED (drifted) attributes
        attr: { value: "hijacked" },
      });
      expect(reconcileCalls(cloud)).toEqual([]);
      // neither the cloud nor the state store were touched
      expect(cloud.resources.get("A")).toMatchObject({ value: "hijacked" });
      expect(yield* getState("A")).toMatchObject({ status: "created", attr: { value: "a" } });
    }).pipe(withCloud(cloud));
  });

  test.provider("reports missing resources without recreating them", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));
      cloud.resources.delete("A");

      cloud.calls.length = 0;
      const result = yield* runDrift({ dryRun: true });

      expect(result.resources.A?.action).toEqual("missing");
      expect(reconcileCalls(cloud)).toEqual([]);
      expect(cloud.resources.has("A")).toBe(false);
      // state still remembers the last-deployed attributes
      expect((yield* getState("A"))?.attr).toMatchObject({ value: "a" });
    }).pipe(withCloud(cloud));
  });

  test.provider("reports unchanged resources as unchanged", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));
      const result = yield* runDrift({ dryRun: true });
      expect(result.resources.A?.action).toEqual("unchanged");
    }).pipe(withCloud(cloud));
  });
});

describe("skipped resources", { tags: ["unit", "local"] }, () => {
  test.provider("a provider without read is skipped with a reason", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(Bucket("MyBucket", { name: "test-bucket" }));

      const result = yield* runDrift();

      expect(result.resources.MyBucket).toMatchObject({
        action: "skipped",
        resourceType: "Test.Bucket",
      });
      expect(result.resources.MyBucket?.reason).toContain("read");
      // skipping is not destructive
      expect((yield* getState("MyBucket"))?.status).toEqual("created");
    }),
  );

  test.provider("resources stuck in a non-terminal status are skipped", () => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* seed({
        Stuck: {
          status: "creating",
          fqn: "Stuck",
          logicalId: "Stuck",
          instanceId,
          resourceType: "Test.DriftResource",
          namespace: undefined,
          providerVersion: 0,
          props: { value: "v" },
          bindings: [],
          downstream: [],
        },
      });

      const result = yield* runDrift();

      expect(result.resources.Stuck?.action).toEqual("skipped");
      expect(result.resources.Stuck?.reason).toContain("creating");
      // no lifecycle operation ran against the unstable resource
      expect(cloud.calls).toEqual([]);
    }).pipe(withCloud(cloud));
  });

  test.provider("resources with a pending replacement chain are skipped", () =>
    Effect.gen(function* () {
      const oldGeneration = {
        status: "created",
        fqn: "R",
        logicalId: "R",
        instanceId: "00000000000000000000000000000000",
        resourceType: "Test.DriftResource",
        namespace: undefined,
        providerVersion: 0,
        props: { value: "v1" },
        attr: { id: "R", value: "v1", tags: {}, env: {} },
        bindings: [],
        downstream: [],
      };
      yield* seed({
        R: {
          status: "replaced",
          fqn: "R",
          logicalId: "R",
          instanceId,
          resourceType: "Test.DriftResource",
          namespace: undefined,
          providerVersion: 0,
          props: { value: "v2" },
          attr: { id: "R", value: "v2", tags: {}, env: {} },
          bindings: [],
          downstream: [],
          deleteFirst: false,
          old: oldGeneration,
        },
      });

      const result = yield* runDrift();

      expect(result.resources.R?.action).toEqual("skipped");
      expect(result.resources.R?.reason).toContain("replacement");
    }),
  );

  test.provider("action state rows are ignored", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));
      yield* seed({
        MyTask: {
          kind: "action",
          status: "ran",
          fqn: "MyTask",
          logicalId: "MyTask",
          actionType: "Test.Task",
          namespace: undefined,
          inputHash: "abc",
          input: {},
          output: { ok: true },
          downstream: [],
        },
      });

      const result = yield* runDrift();

      expect(result.resources.MyTask).toBeUndefined();
      expect(result.resources.A?.action).toEqual("unchanged");
      // the action row survives untouched
      expect(yield* getState("MyTask")).toMatchObject({ kind: "action", status: "ran" });
    }).pipe(withCloud(cloud));
  });
});

describe("failures", { tags: ["unit", "local"] }, () => {
  test.provider(
    "a failing repair does not prevent sibling repairs, and fails the drift",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* DriftResource("A", { value: "a" });
            yield* DriftResource("B", { value: "b" });
          }),
        );

        cloud.resources.get("A")!.value = "hijacked-a";
        cloud.resources.get("B")!.value = "hijacked-b";

        // drift repair goes through the provider's update intent
        const exit = yield* runDrift().pipe(
          Effect.provide(Layer.succeed(TestResourceHooks, failOn("B", "update"))),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const rendered = Cause.pretty(exit.cause);
          expect(rendered).toContain("Resource 'B' (Test.DriftResource) failed during update");
          expect(rendered).toContain("Failed to create");
        }
        // A was still repaired even though B failed
        expect(cloud.resources.get("A")).toMatchObject({ value: "a" });
        expect(yield* getState("A")).toMatchObject({ status: "updated", attr: { value: "a" } });
        // B's cloud state is still drifted and its state row untouched
        expect(cloud.resources.get("B")).toMatchObject({ value: "hijacked-b" });
        expect(yield* getState("B")).toMatchObject({ status: "created", attr: { value: "b" } });

        // a follow-up drift (without the failure) converges B too
        const result = yield* runDrift();
        expect(result.resources).toMatchObject({
          A: { action: "unchanged" },
          B: { action: "repaired" },
        });
        expect(cloud.resources.get("B")).toMatchObject({ value: "b" });
      }).pipe(withCloud(cloud));
    },
  );

  test.provider("a failing recreate goes through the provider's create intent", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));
      cloud.resources.delete("A");

      const exit = yield* runDrift().pipe(
        Effect.provide(Layer.succeed(TestResourceHooks, failOn("A", "create"))),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(cloud.resources.has("A")).toBe(false);

      // recovery: the next drift recreates it
      const result = yield* runDrift();
      expect(result.resources.A?.action).toEqual("recreated");
      expect(cloud.resources.get("A")).toMatchObject({ value: "a" });
    }).pipe(withCloud(cloud));
  });

  test.provider("a failing read fails the drift", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(TestResource("A", { string: "test-string" }));

      const exit = yield* runDrift().pipe(
        Effect.provide(
          Layer.succeed(TestResourceHooks, {
            read: () => Effect.fail(new ResourceFailure("read exploded")),
          }),
        ),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const rendered = Cause.pretty(exit.cause);
        expect(rendered).toContain("Resource 'A' (Test.TestResource) failed during read");
        expect(rendered).toContain("read exploded");
      }
      // state untouched by the failed observation
      expect(yield* getState("A")).toMatchObject({
        status: "created",
        attr: { string: "test-string" },
      });
    }),
  );
});

describe("ownership", { tags: ["unit", "local"] }, () => {
  test.provider("an unowned read result with matching attributes is unchanged", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));

      // ownership markers drifted but the attributes still match — the
      // Unowned brand is a plan-time routing hint, not drift by itself
      cloud.unowned.add("A");

      cloud.calls.length = 0;
      const result = yield* runDrift();

      expect(result.resources.A?.action).toEqual("unchanged");
      expect(reconcileCalls(cloud)).toEqual([]);
    }).pipe(withCloud(cloud));
  });

  test.provider(
    "an unowned, drifted resource is repaired and the brand never persists",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(DriftResource("A", { value: "a" }));

        cloud.unowned.add("A");
        cloud.resources.get("A")!.value = "hijacked";

        const result = yield* runDrift();

        expect(result.resources.A?.action).toEqual("repaired");
        expect(cloud.resources.get("A")).toMatchObject({ value: "a" });
        const state = yield* getState("A");
        expect(state).toMatchObject({ status: "updated", attr: { value: "a" } });
        expect(Unowned.is(state!.attr)).toBe(false);
      }).pipe(withCloud(cloud));
    },
  );
});

describe("bindings", { tags: ["unit", "local"] }, () => {
  test.provider("binding-derived attributes are repaired from the persisted bindings", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* DriftResource("A", { value: "a" });
          yield* a.bind("Env", { env: { FEATURE_FLAG: "on" } });
          return a;
        }),
      );
      expect(created.env).toEqual({ FEATURE_FLAG: "on" });

      // the binding-derived env is wiped out-of-band
      cloud.resources.get("A")!.env = {};

      const result = yield* runDrift();

      expect(result.resources.A?.action).toEqual("repaired");
      // reconcile received the persisted bindings and restored the env
      expect(cloud.resources.get("A")!.env).toEqual({ FEATURE_FLAG: "on" });
      expect((yield* getState("A"))?.attr?.env).toEqual({ FEATURE_FLAG: "on" });
    }).pipe(withCloud(cloud));
  });
});

describe("plan", { tags: ["unit", "local"] }, () => {
  test.provider("projects detection results onto plan node actions", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* DriftResource("Clean", { value: "clean" });
          yield* DriftResource("Drifted", { value: "drifted" });
          yield* DriftResource("Missing", { value: "missing" });
        }),
      );

      cloud.resources.get("Drifted")!.value = "hijacked";
      cloud.resources.delete("Missing");

      cloud.calls.length = 0;
      const stk = yield* Stack;
      const { result, plan } = yield* Drift.plan({ name: stk.name, stage: stk.stage });

      // drifted -> update, missing -> create, unchanged -> noop
      expect(plan.resources.Clean?.action).toEqual("noop");
      expect(plan.resources.Clean?.drift).toBeUndefined();
      expect(plan.resources.Drifted?.action).toEqual("update");
      expect(plan.resources.Missing?.action).toEqual("create");
      expect(plan.resources.Drifted).toMatchObject({
        drift: { expected: { value: "drifted" }, actual: { value: "hijacked" } },
      });
      expect(plan.resources.Missing).toMatchObject({
        drift: { expected: { value: "missing" }, missing: true },
      });
      // detection result rides along
      expect(result.resources).toMatchObject({
        Clean: { action: "unchanged" },
        Drifted: { action: "drifted" },
        Missing: { action: "missing" },
      });
      // the synthetic resource carries what the renderers need
      expect(plan.resources.Drifted?.resource).toMatchObject({
        FQN: "Drifted",
        LogicalId: "Drifted",
        Type: "Test.DriftResource",
      });
      // resource-only view: no deletions/actions in a drift plan
      expect(plan.deletions).toEqual({});
      expect(plan.actions).toEqual({});
      expect(plan.actionDeletions).toEqual({});
      // planning is detection-only: nothing was repaired
      expect(cloud.resources.get("Drifted")).toMatchObject({ value: "hijacked" });
      expect(reconcileCalls(cloud)).toEqual([]);
    }).pipe(withCloud(cloud));
  });

  test.provider("reports each observed resource through the ambient Progress reporter", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* DriftResource("Clean", { value: "clean" });
          yield* DriftResource("Drifted", { value: "drifted" });
        }),
      );
      cloud.resources.get("Drifted")!.value = "hijacked";

      const events: Array<ProgressEvent> = [];
      const stk = yield* Stack;
      yield* Drift.plan({ name: stk.name, stage: stk.stage }).pipe(
        Effect.provideService(Progress, (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
      );

      // Phase markers bracket the observation fan-out.
      expect(
        events.filter((event) => event._tag === "plan.phase").map(({ phase }) => phase),
      ).toEqual(["loading-state", "computing-plan"]);
      // Every read emits a start (so renderers can show in-flight rows)
      // paired with a completion.
      expect(
        events
          .filter((event) => event._tag === "plan.resource.started")
          .map(({ logicalId }) => logicalId)
          .sort(),
      ).toEqual(["Clean", "Drifted"]);
      const nodes = events.filter((event) => event._tag === "plan.resource.completed");
      expect(nodes).toHaveLength(2);
      expect(nodes.map(({ completed }) => completed).sort()).toEqual([1, 2]);
      expect(Object.fromEntries(nodes.map((event) => [event.logicalId, event.action]))).toEqual({
        Clean: "noop",
        Drifted: "update",
      });
      for (const event of nodes) {
        expect(event).toMatchObject({ _tag: "plan.resource.completed", total: 2 });
      }
    }).pipe(withCloud(cloud));
  });

  test.provider("skipped resources render as noop nodes carrying persisted state", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(Bucket("MyBucket", { name: "test-bucket" }));

      const stk = yield* Stack;
      const { result, plan } = yield* Drift.plan({ name: stk.name, stage: stk.stage });

      expect(result.resources.MyBucket?.action).toEqual("skipped");
      expect(plan.resources.MyBucket).toMatchObject({
        action: "noop",
        state: { status: "created" },
        resource: { LogicalId: "MyBucket", Type: "Test.Bucket" },
      });
    }),
  );

  test.provider("namespaced resources keep their namespace, FQN and bindings", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      const Site = (id: string) =>
        Effect.gen(function* () {
          const a = yield* DriftResource("A", { value: "a" });
          yield* a.bind("Env", { env: { KEY: "on" } });
          return a;
        }).pipe(Namespace.push(id));

      yield* stack.deploy(Site("Site"));

      cloud.resources.get("A")!.value = "hijacked";

      const stk = yield* Stack;
      const { plan } = yield* Drift.plan({ name: stk.name, stage: stk.stage });

      const node = plan.resources["Site/A"];
      expect(node?.action).toEqual("update");
      expect(node?.resource).toMatchObject({ FQN: "Site/A", LogicalId: "A" });
      expect(node?.resource.Namespace).toBeDefined();
      // persisted bindings surface as noop rows (topology, not changes)
      expect(node?.bindings).toMatchObject([{ sid: "Env", action: "noop" }]);
    }).pipe(withCloud(cloud));
  });
});

describe("session events", { tags: ["unit", "local"] }, () => {
  test.provider("repair reports progress through the provided session", (stack) => {
    const cloud = makeTestCloud();
    const events: ApplyEvent[] = [];
    const session = {
      emit: (event: ApplyEvent) =>
        Effect.sync(() => {
          events.push(event);
        }),
      done: () => Effect.void,
    };
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* DriftResource("Drifted", { value: "drifted" });
          yield* DriftResource("Missing", { value: "missing" });
          yield* Bucket("MyBucket", { name: "test-bucket" });
        }),
      );

      cloud.resources.get("Drifted")!.value = "hijacked";
      cloud.resources.delete("Missing");

      yield* runDrift({ session });

      // drift repair reports the update lifecycle
      expect(events).toContainEqual({
        _tag: "apply.resource.status",
        fqn: "Drifted",
        id: "Drifted",
        type: "Test.DriftResource",
        status: "updating",
      });
      expect(events).toContainEqual({
        _tag: "apply.resource.status",
        fqn: "Drifted",
        id: "Drifted",
        type: "Test.DriftResource",
        status: "updated",
      });
      // recreation reports the create lifecycle
      expect(events).toContainEqual({
        _tag: "apply.resource.status",
        fqn: "Missing",
        id: "Missing",
        type: "Test.DriftResource",
        status: "creating",
      });
      expect(events).toContainEqual({
        _tag: "apply.resource.status",
        fqn: "Missing",
        id: "Missing",
        type: "Test.DriftResource",
        status: "created",
      });
      // skipped resources settle with a terminal status and a reason note
      expect(events).toContainEqual({
        _tag: "apply.resource.status",
        fqn: "MyBucket",
        id: "MyBucket",
        type: "Test.Bucket",
        status: "skipped",
      });
      expect(
        events.some(
          (e) =>
            e._tag === "apply.resource.note" && e.id === "MyBucket" && e.message.includes("read"),
        ),
      ).toBe(true);
    }).pipe(withCloud(cloud));
  });
});

// Repairs follow the persisted `downstream` edges, like Apply: an upstream
// is recreated before anything that points at it. The TestCloud enforces
// this — a DriftResource reconcile fails when a `dependsOn` id is missing.
describe("dependency order", { tags: ["unit", "local"] }, () => {
  test.provider("a deleted chain is recreated upstream first", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* DriftResource("Topic", { value: "topic" });
          const queue = yield* DriftResource("Queue", { value: "queue", dependsOn: [topic.id] });
          yield* DriftResource("Subscription", { value: "sub", dependsOn: [queue.id] });
        }),
      );
      expect((yield* getState("Topic"))?.downstream).toEqual(["Queue"]);

      for (const id of ["Topic", "Queue", "Subscription"]) cloud.resources.delete(id);
      cloud.calls.length = 0;
      const result = yield* runDrift();

      expect(result.resources).toMatchObject({
        Topic: { action: "recreated" },
        Queue: { action: "recreated" },
        Subscription: { action: "recreated" },
      });
      expect(reconcileCalls(cloud)).toEqual(["Topic", "Queue", "Subscription"]);
    }).pipe(withCloud(cloud));
  });

  test.provider("a diamond waits for every upstream", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const root = yield* DriftResource("Root", {});
          const left = yield* DriftResource("Left", { dependsOn: [root.id] });
          const right = yield* DriftResource("Right", { dependsOn: [root.id] });
          yield* DriftResource("Leaf", { dependsOn: [left.id, right.id] });
        }),
      );

      for (const id of ["Root", "Left", "Right", "Leaf"]) cloud.resources.delete(id);
      cloud.calls.length = 0;
      yield* runDrift();

      const order = reconcileCalls(cloud);
      expect(order[0]).toEqual("Root");
      expect(order.slice(1, 3).sort()).toEqual(["Left", "Right"]);
      expect(order[3]).toEqual("Leaf");
    }).pipe(withCloud(cloud));
  });

  test.provider("independent resources are repaired concurrently", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* DriftResource("X", {});
          yield* DriftResource("Y", {});
        }),
      );
      cloud.resources.delete("X");
      cloud.resources.delete("Y");

      // Each create waits for the other to start: only a concurrent
      // repair can finish.
      const started = {
        X: yield* Deferred.make<void>(),
        Y: yield* Deferred.make<void>(),
      };
      const hooks = {
        create: (id: string) =>
          id === "X" || id === "Y"
            ? Deferred.succeed(started[id], undefined).pipe(
                Effect.andThen(Deferred.await(started[id === "X" ? "Y" : "X"])),
                Effect.timeout("2 seconds"),
              )
            : Effect.void,
      };
      const result = yield* runDrift().pipe(
        Effect.provide(Layer.succeed(TestResourceHooks, hooks)),
      );

      expect(result.resources).toMatchObject({
        X: { action: "recreated" },
        Y: { action: "recreated" },
      });
    }).pipe(withCloud(cloud));
  });

  test.provider("a missing resource under an intact upstream recreates directly", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* DriftResource("Topic", { value: "topic" });
          yield* DriftResource("Subscription", { value: "sub", dependsOn: [topic.id] });
        }),
      );
      cloud.resources.delete("Subscription");

      cloud.calls.length = 0;
      const result = yield* runDrift();

      expect(result.resources).toMatchObject({
        Topic: { action: "unchanged" },
        Subscription: { action: "recreated" },
      });
      expect(reconcileCalls(cloud)).toEqual(["Subscription"]);
    }).pipe(withCloud(cloud));
  });

  test.provider(
    "a drifted resource is repaired after its missing upstream is recreated",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            const topic = yield* DriftResource("Topic", { value: "topic" });
            yield* DriftResource("Subscription", { value: "sub", dependsOn: [topic.id] });
          }),
        );
        cloud.resources.delete("Topic");
        cloud.resources.get("Subscription")!.value = "hijacked";

        cloud.calls.length = 0;
        const result = yield* runDrift();

        expect(result.resources).toMatchObject({
          Topic: { action: "recreated" },
          Subscription: { action: "repaired", attr: { value: "sub" } },
        });
        expect(reconcileCalls(cloud)).toEqual(["Topic", "Subscription"]);
      }).pipe(withCloud(cloud));
    },
  );

  test.provider("namespaced resources order by FQN", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* DriftResource("Topic", {});
          yield* DriftResource("Subscription", { dependsOn: [topic.id] });
        }).pipe(Namespace.push("Uploads")),
      );
      expect((yield* getState("Uploads/Topic"))?.downstream).toEqual(["Uploads/Subscription"]);
      cloud.resources.delete("Topic");
      cloud.resources.delete("Subscription");

      cloud.calls.length = 0;
      const result = yield* runDrift();

      expect(result.resources["Uploads/Subscription"]?.action).toEqual("recreated");
      expect(reconcileCalls(cloud)).toEqual(["Topic", "Subscription"]);
    }).pipe(withCloud(cloud));
  });

  test.provider("cyclic or dangling persisted edges do not deadlock the repair", () => {
    const cloud = makeTestCloud();
    const row = (fqn: string, downstream: string[]) => ({
      status: "created",
      fqn,
      logicalId: fqn,
      instanceId,
      resourceType: "Test.DriftResource",
      namespace: undefined,
      providerVersion: 0,
      props: { value: fqn },
      attr: { id: fqn, value: fqn, tags: {}, env: {} },
      bindings: [],
      downstream,
    });
    return Effect.gen(function* () {
      // Merged historical edges can disagree with each other; a cycle among
      // them, or an edge to a row that no longer exists, must not block.
      yield* seed({ A: row("A", ["B", "Ghost"]), B: row("B", ["A"]), C: row("C", ["A"]) });

      const result = yield* runDrift().pipe(Effect.timeout("2 seconds"));

      expect(result.resources).toMatchObject({
        A: { action: "recreated" },
        B: { action: "recreated" },
        C: { action: "recreated" },
      });
      // the acyclic edge still orders C before A
      const order = reconcileCalls(cloud);
      expect(order.indexOf("C")).toBeLessThan(order.indexOf("A"));
    }).pipe(withCloud(cloud));
  });

  test.provider("dry run reports a deleted chain without ordering any repair", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* DriftResource("Topic", {});
          yield* DriftResource("Subscription", { dependsOn: [topic.id] });
        }),
      );
      cloud.resources.delete("Topic");
      cloud.resources.delete("Subscription");

      cloud.calls.length = 0;
      const result = yield* runDrift({ dryRun: true });

      expect(result.resources).toMatchObject({
        Topic: { action: "missing" },
        Subscription: { action: "missing" },
      });
      expect(reconcileCalls(cloud)).toEqual([]);
    }).pipe(withCloud(cloud));
  });
});

// Missing resources are recreated bare, then bound once every missing
// resource exists again: binding data can point at a resource recreated
// later, and a binding edge inside a cycle is not a persisted `downstream`
// edge. The TestCloud fails a reconcile whose binding `targets` are missing.
describe("bindings of recreated resources", { tags: ["unit", "local"] }, () => {
  test.provider("a missing resource is recreated bare, then bound", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* DriftResource("A", { value: "a" });
          yield* a.bind("Env", { env: { FEATURE_FLAG: "on" } });
        }),
      );
      cloud.resources.delete("A");

      cloud.calls.length = 0;
      const { events, session } = recordingSession();
      const result = yield* runDrift({ session });

      expect(result.resources.A).toMatchObject({
        action: "recreated",
        attr: { env: { FEATURE_FLAG: "on" } },
      });
      expect(reconcileTrace(cloud)).toEqual(["A[]", "A[Env]"]);
      expect(cloud.resources.get("A")!.env).toEqual({ FEATURE_FLAG: "on" });
      expect(yield* getState("A")).toMatchObject({
        status: "created",
        bindings: [{ sid: "Env" }],
        attr: { env: { FEATURE_FLAG: "on" } },
      });
      // one create lifecycle, even across both reconciles
      expect(statusesOf(events, "A")).toEqual(["creating", "created"]);
    }).pipe(withCloud(cloud));
  });

  test.provider("a missing resource without bindings is reconciled once", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));
      cloud.resources.delete("A");

      cloud.calls.length = 0;
      yield* runDrift();

      expect(reconcileTrace(cloud)).toEqual(["A[]"]);
    }).pipe(withCloud(cloud));
  });

  test.provider("a drifted resource keeps its bindings in a single reconcile", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* DriftResource("A", { value: "a" });
          yield* a.bind("Env", { env: { FEATURE_FLAG: "on" } });
        }),
      );
      cloud.resources.get("A")!.value = "hijacked";

      cloud.calls.length = 0;
      yield* runDrift();

      expect(reconcileTrace(cloud)).toEqual(["A[Env]"]);
    }).pipe(withCloud(cloud));
  });

  // The #1536 shape: the topic's props point at the bucket, and the bucket's
  // notification binding points back at the topic.
  test.provider("a binding cycle is recreated bare, then bound", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* DriftResource("Bucket", { value: "bucket" });
          const topic = yield* DriftResource("Topic", { value: "topic", dependsOn: [bucket.id] });
          yield* bucket.bind("Notifications", { targets: [topic.id] });
        }),
      );
      // the cyclic binding edge is not persisted as a downstream edge
      expect((yield* getState("Topic"))?.downstream).toEqual([]);
      cloud.resources.delete("Bucket");
      cloud.resources.delete("Topic");

      cloud.calls.length = 0;
      const result = yield* runDrift();

      expect(result.resources).toMatchObject({
        Bucket: { action: "recreated" },
        Topic: { action: "recreated" },
      });
      expect(reconcileTrace(cloud)).toEqual(["Bucket[]", "Topic[]", "Bucket[Notifications]"]);
      expect((yield* getState("Bucket"))?.bindings).toMatchObject([{ sid: "Notifications" }]);
    }).pipe(withCloud(cloud));
  });

  test.provider("a binding pointing at a later-recreated resource is attached last", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* DriftResource("A", {});
          const b = yield* DriftResource("B", { dependsOn: [a.id] });
          yield* a.bind("Points", { targets: [b.id] });
        }),
      );
      cloud.resources.delete("A");
      cloud.resources.delete("B");

      cloud.calls.length = 0;
      yield* runDrift();

      expect(reconcileTrace(cloud)).toEqual(["A[]", "B[]", "A[Points]"]);
    }).pipe(withCloud(cloud));
  });

  test.provider("a failed bind leaves an unbound row that the next deploy binds", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const a = yield* DriftResource("A", { value: "a" });
        yield* a.bind("Env", { env: { FEATURE_FLAG: "on" } });
        return a;
      });
      yield* stack.deploy(program);
      cloud.resources.delete("A");

      // the bare recreate succeeds; attaching the binding (an update of the
      // recreated resource) fails
      const exit = yield* runDrift().pipe(
        Effect.provide(Layer.succeed(TestResourceHooks, failOn("A", "update"))),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(cloud.resources.get("A")).toMatchObject({ value: "a", env: {} });
      // state records the resource without the binding it does not have
      expect(yield* getState("A")).toMatchObject({ status: "created", bindings: [] });

      // so the next deploy plans the binding and attaches it
      const deployed = yield* stack.deploy(program);
      expect(deployed.env).toEqual({ FEATURE_FLAG: "on" });
      expect(cloud.resources.get("A")!.env).toEqual({ FEATURE_FLAG: "on" });
    }).pipe(withCloud(cloud));
  });
});

describe("dependency failures", { tags: ["unit", "local"] }, () => {
  test.provider(
    "a failed upstream recreate fails its dependents but not unrelated repairs",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            const topic = yield* DriftResource("Topic", {});
            yield* DriftResource("Subscription", { dependsOn: [topic.id] });
            yield* DriftResource("Other", {});
          }),
        );
        for (const id of ["Topic", "Subscription", "Other"]) cloud.resources.delete(id);

        const exit = yield* runDrift().pipe(
          Effect.provide(Layer.succeed(TestResourceHooks, failOn("Topic", "create"))),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const rendered = Cause.pretty(exit.cause);
          expect(rendered).toContain("Resource 'Topic' (Test.DriftResource) failed during create");
          expect(rendered).toContain(
            "Resource 'Subscription' (Test.DriftResource) failed during create",
          );
        }
        expect(cloud.resources.has("Topic")).toBe(false);
        expect(cloud.resources.has("Subscription")).toBe(false);
        expect(cloud.resources.has("Other")).toBe(true);

        // the next drift converges the rest of the chain
        const result = yield* runDrift();
        expect(result.resources).toMatchObject({
          Topic: { action: "recreated" },
          Subscription: { action: "recreated" },
          Other: { action: "unchanged" },
        });
      }).pipe(withCloud(cloud));
    },
  );

  test.provider("a failed bare recreate skips attaching its bindings", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* DriftResource("A", {});
          yield* a.bind("Env", { env: { KEY: "on" } });
        }),
      );
      cloud.resources.delete("A");

      cloud.calls.length = 0;
      const exit = yield* runDrift().pipe(
        Effect.provide(Layer.succeed(TestResourceHooks, failOn("A", "create"))),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(reconcileTrace(cloud)).toEqual(["A[]"]);
      // the row is untouched, so the resource is still reported missing
      expect(yield* getState("A")).toMatchObject({ bindings: [{ sid: "Env" }] });
      const detected = yield* runDrift({ dryRun: true });
      expect(detected.resources.A?.action).toEqual("missing");
    }).pipe(withCloud(cloud));
  });
});
