import { DurableObjectState } from "@alchemy.run/cloudflare/Workers/DurableObjectState";
import { describe, expect, it } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import {
  makeDurableObjectEngine,
  type Namespace,
  type ObjectImpl,
} from "alchemy/Workers/DurableObjectEngine";
import { ensureAlarmTables } from "alchemy/Workers/Workerd/DurableObjectAlarmStorage";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { Activity, DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow";
import { makeAlarmScheduler } from "./fixtures/alarm-scheduler.ts";

/** Greets in one activity; told to wait, it then waits for a signal. */
const Once = Workflow.make("Once", {
  payload: { id: Schema.String, wait: Schema.Boolean },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

const Signal = DurableDeferred.make("Signal");

/**
 * The Durable Object workflow engine over one execution instance, on real
 * SQLite and the production alarm scheduler. `restart` rebuilds the instance
 * on the same storage, as workerd does after a reset.
 */
const makeExecution = Effect.gen(function* () {
  const fixture = yield* makeAlarmScheduler;
  const runtime = Layer.succeed(RuntimeContext, {
    Type: "Test",
    id: "durable-object-engine-test",
    env: {},
    get: () => Effect.succeed(undefined),
    set: (id: string) => Effect.succeed(id),
    makeCallback: fixture.register,
  });
  const state = Layer.succeed(DurableObjectState, fixture.state);

  let impl: ObjectImpl<DurableObjectState> | undefined;
  let methods: Record<string, (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown>> = {};
  const build = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const inner = yield* impl!.pipe(Effect.provide(state));
    methods = (yield* inner.pipe(
      Effect.provide(Layer.mergeAll(state, runtime)),
      Scope.provide(scope),
    )) as typeof methods;
    fixture.seal();
  });
  const namespace: Namespace = {
    getByName: () =>
      new Proxy(
        {},
        {
          get:
            (_, method: string) =>
            (...args: ReadonlyArray<unknown>) =>
              Effect.suspend(() => methods[method]!(...args)),
        },
      ),
  };
  const engine = makeDurableObjectEngine<never, DurableObjectState>({
    declare: (_name, declared) =>
      Effect.sync(() => {
        impl = declared;
        return namespace;
      }),
    state: DurableObjectState,
  });

  const activities: string[] = [];
  const OnceLive = Workflows.layer(
    Once,
    Effect.succeed(
      Effect.fn(function* ({ id, wait }) {
        const greeting = yield* Activity.make({
          name: "greet",
          success: Schema.String,
          execute: Effect.sync(() => {
            activities.push(id);
            return `hello ${id}`;
          }),
        });
        if (wait) yield* DurableDeferred.await(Signal);
        return greeting;
      }),
    ),
  );
  const context = yield* Layer.build(OnceLive.pipe(Layer.provideMerge(engine)));
  yield* build;

  return {
    fixture,
    activities,
    restart: Effect.suspend(() => {
      fixture.restart();
      return build;
    }),
    start: (id: string, wait = false) =>
      Once.execute({ id, wait }, { discard: true }).pipe(Effect.provide(context)),
    /** The pending run job, if any. */
    pendingRun: Effect.sync(
      () =>
        fixture.db
          .query<{ version: string }, []>(
            "SELECT version FROM alchemy_alarm_callbacks WHERE callback = 'run' AND id = 'run'",
          )
          .get() ?? undefined,
    ),
    poll: (executionId: string) =>
      Effect.flatMap(WorkflowEngine.WorkflowEngine, (engine) =>
        engine.poll(Once, executionId),
      ).pipe(Effect.provide(context)),
    /** Fire the native alarm until nothing is scheduled. */
    drain: Effect.gen(function* () {
      for (let fired = 0; fixture.alarm !== null && fired < 10; fired++) yield* fixture.fire;
    }),
  };
}).pipe(Effect.provide(RuntimeContext.phantom));

describe(
  "Durable Object workflow engine",
  { tags: ["unit", "local", "provider:cloudflare", "provider:cloudflare:worker"] },
  () => {
    // https://github.com/alchemy-run/alchemy/issues/3177
    it.effect("a start whose first wake fails leaves nothing to strand", () =>
      Effect.gen(function* () {
        const execution = yield* makeExecution;
        const { db } = execution.fixture;
        yield* ensureAlarmTables(execution.fixture.raw.storage as never);
        db.exec(
          `CREATE TRIGGER fail_first_wake BEFORE INSERT ON alchemy_alarm_callbacks
           WHEN NEW.callback = 'run' AND NEW.id = 'run'
           BEGIN SELECT RAISE(ABORT, 'injected'); END`,
        );
        const failed = yield* Effect.exit(execution.start("a"));
        expect(Exit.isFailure(failed)).toBe(true);
        db.exec("DROP TRIGGER fail_first_wake");
        // The failed start committed nothing.
        expect(db.query("SELECT * FROM workflow_execution").all()).toEqual([]);

        yield* execution.restart;
        const executionId = yield* execution.start("a");
        yield* execution.drain;

        expect(yield* execution.poll(executionId)).toEqual(
          Option.some(new Workflow.Complete({ exit: Exit.succeed("hello a") })),
        );
        expect(execution.activities).toEqual(["a"]);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect("a duplicate start runs an execution an earlier engine stranded", () =>
      Effect.gen(function* () {
        const execution = yield* makeExecution;
        // What an engine that committed the execution before scheduling its
        // first run left behind when that schedule failed.
        const executionId = yield* Once.executionId({ id: "b", wait: false });
        execution.fixture.db
          .query("INSERT INTO workflow_execution (id, execution_id, payload) VALUES (1, ?, ?)")
          .run(executionId, JSON.stringify({ id: "b", wait: false }));

        yield* execution.start("b");
        yield* execution.drain;

        expect(yield* execution.poll(executionId)).toEqual(
          Option.some(new Workflow.Complete({ exit: Exit.succeed("hello b") })),
        );
        expect(execution.activities).toEqual(["b"]);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect("a duplicate start leaves a pending run alone", () =>
      Effect.gen(function* () {
        const execution = yield* makeExecution;
        const executionId = yield* execution.start("c");
        const pending = yield* execution.pendingRun;
        expect(pending).toBeDefined();

        yield* execution.start("c");
        expect(yield* execution.pendingRun).toEqual(pending);

        yield* execution.drain;
        expect(yield* execution.poll(executionId)).toEqual(
          Option.some(new Workflow.Complete({ exit: Exit.succeed("hello c") })),
        );
        expect(execution.activities).toEqual(["c"]);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect("a duplicate start doesn't wake a run waiting for a signal", () =>
      Effect.gen(function* () {
        const execution = yield* makeExecution;
        const executionId = yield* execution.start("d", true);
        yield* execution.drain;
        expect(yield* execution.poll(executionId)).toEqual(
          Option.some(Workflow.Suspended.make({})),
        );

        yield* execution.start("d", true);
        expect(yield* execution.pendingRun).toBeUndefined();
        expect(execution.fixture.alarm).toBeNull();
        expect(execution.activities).toEqual(["d"]);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );

    it.effect("a duplicate start doesn't rerun a finished execution", () =>
      Effect.gen(function* () {
        const execution = yield* makeExecution;
        const executionId = yield* execution.start("e");
        yield* execution.drain;
        yield* execution.start("e");

        expect(yield* execution.pendingRun).toBeUndefined();
        expect(yield* execution.poll(executionId)).toEqual(
          Option.some(new Workflow.Complete({ exit: Exit.succeed("hello e") })),
        );
        expect(execution.activities).toEqual(["e"]);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );
  },
);
