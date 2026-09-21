import { describe, expect, test } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  processScheduledEvent,
  cron,
  CronEventSourceLive,
} from "@/Celld/CronEventSource.ts";
import { Worker } from "@/Celld/Worker.ts";
import type { Queue } from "@/Celld/Queues/Queue.ts";
import {
  consumeQueueMessages,
  EventSourceLive,
} from "@/Celld/Queues/EventSource.ts";
import { makeFleetBootstrap } from "@/Runtime/Bootstrap/CelldFleet.ts";
import type { DurableObject } from "cloudflare:workers";
import { makeCelldVirtualEntry } from "@/Celld/FleetEntry.ts";
import {
  claimConsumer,
  toQueueConsumer,
  validateConsumerSettings,
} from "@/Celld/Queues/Consumer.ts";
import {
  processQueueBatch,
  toConsumerSettings,
} from "@/Celld/Queues/EventSource.ts";
import type {
  Message,
  MessageBatch,
  NativeQueue,
} from "@/Celld/Queues/QueueTypes.ts";
import { makeWriteQueueClient } from "@/Celld/Queues/WriteQueueBinding.ts";
import { makeCelldWorkerBridge } from "@/Celld/WorkerBridge.ts";
import {
  isWorkflowExport,
  Workflow,
  makeWorkflowHandle,
  type WorkflowExport,
} from "@/Celld/Workflows/Workflow.ts";
import { runWorkflow } from "@/Celld/Workflows/WorkflowBridge.ts";
import {
  task,
  sleep,
  sleepUntil,
  waitForEvent,
  WorkflowEvent,
  WorkflowStepContext,
} from "@/Celld/Workflows/WorkflowRuntime.ts";
import type {
  NativeWorkflow,
  NativeWorkflowInstance,
  NativeWorkflowStep,
  WorkflowStepContextData,
} from "@/Celld/Workflows/WorkflowTypes.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { getSharedBuild, WorkerEnvironment } from "@/Workers/Worker.ts";
import { NonRetryableError } from "@/Celld/Workflows/WorkflowTypes.ts";
import { makeWorkerRuntimeContext } from "@/Cloudflare/Workers/WorkerRuntimeContext.ts";
import type { DurableObjectExport } from "@/Workers/DurableObject.ts";
import type { WorkerEntrypoint } from "cloudflare:workers";

const Host = Context.Service<
  Effect.Services<typeof Worker>,
  Effect.Success<typeof Worker>
>("Alchemy::Self<Celld.Worker>");
const runtimeContext = makeWorkerRuntimeContext("test");
const runtime = Layer.succeed(RuntimeContext, runtimeContext);
const context = Context.make(RuntimeContext, runtimeContext);
const event = {
  payload: { value: 42 },
  timestamp: new Date(0),
  instanceId: "test",
  workflowName: "Test",
};
const attempt: WorkflowStepContextData = {
  step: { name: "task", count: 1 },
  attempt: 2,
  config: { retries: { limit: 3, delay: 1000 }, timeout: 1000 },
};
const nativeStep: NativeWorkflowStep = {
  do: (_name, _config, callback) => callback(attempt),
  sleep: () => Effect.runPromise(Effect.void),
  sleepUntil: () => Effect.runPromise(Effect.void),
  waitForEvent: <T>(_name: string, options: { type: string }) =>
    Effect.runPromise(
      Effect.succeed({
        payload: { approved: true } as T,
        timestamp: new Date(0),
        type: options.type,
      }),
    ),
};

const batch = () => {
  const settled = new Map<string, string>();
  const messages = ["a", "b", "c"].map((id): Message<string> => ({
    id,
    timestamp: new Date(0),
    body: id,
    attempts: 1,
    ack: () => {
      if (!settled.has(id)) settled.set(id, "ack");
    },
    retry: (options) => {
      if (!settled.has(id))
        settled.set(id, `retry:${options?.delaySeconds ?? "default"}`);
    },
  }));
  return {
    settled,
    value: {
      queue: "jobs",
      messages,
      metadata: { metrics: { backlogCount: 3, backlogBytes: 3 } },
      ackAll: () => {
        throw new Error("must not override per-message settlement");
      },
      retryAll: () => {
        throw new Error("must not override per-message settlement");
      },
    } satisfies MessageBatch<string>,
  };
};

describe("Celld native runtime adapters", () => {
  test("consumer durations and ranges match deployment fields", () => {
    expect(
      toQueueConsumer(
        toConsumerSettings({
          maxWaitTime: "1500 millis",
          retryDelay: "1100 millis",
        }),
      ),
    ).toMatchObject({ maxBatchTimeout: 2, retryDelay: 2 });
    for (const settings of [
      { batchSize: 0 },
      { batchSize: 101 },
      { maxWaitTimeMs: 60001 },
      { maxRetries: -1 },
      { retryDelay: 86401 },
      { maxConcurrency: 251 },
    ]) {
      expect(
        Result.isFailure(
          Effect.runSync(Effect.result(validateConsumerSettings(settings))),
        ),
      ).toBe(true);
    }
  });

  test.live(
    "duplicate consumers fail before metadata can overwrite settings",
    () =>
      Effect.gen(function* () {
        const host = {};
        yield* claimConsumer(host, "jobs");
        const duplicate = yield* claimConsumer(host, "jobs").pipe(
          Effect.result,
        );
        expect(Result.isFailure(duplicate)).toBe(true);
        yield* claimConsumer({}, "jobs");
        yield* claimConsumer(host, "other");
      }),
  );

  test.live("successful queue processing preserves explicit retry", () =>
    Effect.gen(function* () {
      const current = batch();
      yield* processQueueBatch(current.value, (messages) =>
        Stream.runForEach(messages, (message) =>
          Effect.sync(() => {
            if (message.id === "b") message.retry({ delaySeconds: 7 });
          }),
        ),
      );
      expect([...current.settled]).toEqual([
        ["b", "retry:7"],
        ["a", "ack"],
        ["c", "ack"],
      ]);
    }),
  );

  test.live("failed queue processing preserves explicit acknowledgement", () =>
    Effect.gen(function* () {
      const current = batch();
      yield* processQueueBatch(current.value, () =>
        Effect.sync(() => current.value.messages[0].ack()).pipe(
          Effect.andThen(Effect.fail("failed")),
        ),
      );
      expect([...current.settled]).toEqual([
        ["a", "ack"],
        ["b", "retry:default"],
        ["c", "retry:default"],
      ]);
    }),
  );

  test.live(
    "producer resolves bindings lazily and preserves native options",
    () =>
      Effect.gen(function* () {
        const calls: unknown[] = [];
        let reads = 0;
        const queue: NativeQueue = {
          send: (...args) =>
            Effect.runPromise(
              Effect.sync(() => {
                calls.push(args);
              }),
            ),
          sendBatch: (...args) =>
            Effect.runPromise(
              Effect.sync(() => {
                calls.push(args);
              }),
            ),
        };
        const writer = makeWriteQueueClient(() => {
          reads++;
          return queue;
        });
        expect(reads).toBe(0);
        yield* Effect.gen(function* () {
          yield* writer.send("hello", { contentType: "text", delaySeconds: 3 });
          yield* writer.sendBatch([{ body: "later", delaySeconds: 4 }], {
            delaySeconds: 2,
          });
        }).pipe(Effect.provide(runtime));
        expect(reads).toBe(2);
        expect(calls).toEqual([
          ["hello", { contentType: "text", delaySeconds: 3 }],
          [[{ body: "later", delaySeconds: 4 }], { delaySeconds: 2 }],
        ]);
      }),
  );

  test.live(
    "cron filters expressions and surfaces failures with noRetry intact",
    () =>
      Effect.gen(function* () {
        let noRetry = false;
        const controller = {
          cron: "0 * * * *",
          scheduledTime: 123,
          noRetry: () => {
            noRetry = true;
          },
        };
        yield* processScheduledEvent("0 0 * * *", controller, () =>
          Effect.die("wrong schedule"),
        );
        const result = yield* processScheduledEvent(
          controller.cron,
          controller,
          (input) =>
            Effect.sync(() => input.noRetry()).pipe(
              Effect.andThen(Effect.fail("scheduled failure")),
            ),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(noRetry).toBe(true);
      }),
  );

  test("generated entry separates workflows and Durable Objects", () => {
    const workflow: WorkflowExport = {
      kind: "Celld.WorkflowExport",
      run: () => Effect.void,
    };
    const object: DurableObjectExport = {
      kind: "durableObject",
      provider: "Celld",
      constructor: Effect.succeed(Effect.succeed({})),
      services: Context.empty(),
    };
    const source = makeCelldVirtualEntry(
      { Counter: object, Reports: workflow },
      { name: "test", stage: "runtime" },
    )("./worker.ts");
    expect(source).toContain(
      'export class Counter extends fleet.durableObject("Counter")',
    );
    expect(source).toContain(
      'export class Reports extends fleet.workflow("Reports")',
    );
    expect(source).not.toContain('fleet.durableObject("Reports")');
    expect(source).toContain("export default fleet.default");
    expect(isWorkflowExport({ kind: "workflow" })).toBe(false);
    expect(isWorkflowExport(workflow)).toBe(true);
  });

  test.live(
    "workflow task preserves attempts, context, events and request finalizers",
    () =>
      Effect.gen(function* () {
        const scopes: Scope.Scope[] = [];
        const memoMaps: Layer.MemoMap[] = [];
        const closed: string[] = [];
        const workflow: WorkflowExport = {
          kind: "Celld.WorkflowExport",
          run: () =>
            Effect.gen(function* () {
              scopes.push(yield* Scope.Scope);
              memoMaps.push(yield* Layer.CurrentMemoMap);
              yield* Effect.addFinalizer((exit) =>
                Effect.sync(() => {
                  closed.push(exit._tag);
                }),
              );
              const input = yield* WorkflowEvent;
              yield* sleep("pause", 1);
              yield* sleepUntil("deadline", 1);
              const delivered = yield* waitForEvent<{ approved: boolean }>(
                "approval",
                { type: "approval", timeout: "1 second" },
              );
              const tries = yield* task(
                "task",
                WorkflowStepContext.pipe(Effect.map((info) => info.attempt)),
              );
              return {
                payload: input.payload,
                approved: delivered.payload.approved,
                tries,
              };
            }),
        };
        expect(
          yield* runWorkflow(workflow, event, nativeStep, {}, context),
        ).toEqual({ payload: { value: 42 }, approved: true, tries: 2 });
        yield* runWorkflow(workflow, event, nativeStep, {}, context);
        expect(scopes[0]).not.toBe(scopes[1]);
        expect(memoMaps[0]).not.toBe(memoMaps[1]);
        expect(closed).toEqual(["Success", "Success"]);
      }),
  );

  test.live("workflow closes failed run resources with the failure exit", () =>
    Effect.gen(function* () {
      let closed: string | undefined;
      const workflow: WorkflowExport = {
        kind: "Celld.WorkflowExport",
        run: () =>
          Effect.addFinalizer((exit) =>
            Effect.sync(() => {
              closed = exit._tag;
            }),
          ).pipe(Effect.andThen(Effect.fail("failure"))),
      };
      const result = yield* runWorkflow(
        workflow,
        event,
        nativeStep,
        {},
        context,
      ).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(closed).toBe("Failure");
    }),
  );

  test.live(
    "workflow dynamic retry delay receives the native error and captured services",
    () =>
      Effect.gen(function* () {
        class Delay extends Context.Service<Delay, number>()(
          "Test.Celld.Delay",
        ) {}
        let received: unknown;
        const error = new Error("retry");
        const step: NativeWorkflowStep = {
          ...nativeStep,
          do: (_name, config, callback) =>
            Effect.runPromise(
              Effect.gen(function* () {
                const delay = config.retries?.delay;
                if (typeof delay === "function") {
                  received = yield* Effect.promise(() =>
                    delay({ ctx: attempt, error }),
                  );
                }
                return yield* Effect.promise(() => callback(attempt));
              }),
            ),
        };
        const workflow: WorkflowExport = {
          kind: "Celld.WorkflowExport",
          run: () =>
            task("task", Effect.succeed(1), {
              retries: {
                limit: 2,
                delay: (input) =>
                  Effect.gen(function* () {
                    expect(input.error).toBe(error);
                    return (yield* Delay) * input.ctx.attempt;
                  }),
              },
            }).pipe(Effect.provide(Layer.succeed(Delay, 100))),
        };
        yield* runWorkflow(workflow, event, step, {}, context);
        expect(received).toBe(200);
      }),
  );

  test.live(
    "workflow typed failure survives exhaustion and persisted replay",
    () =>
      Effect.gen(function* () {
        class Busy extends Data.TaggedError("Busy")<{ attempt: number }> {}
        const scopes: Scope.Scope[] = [];
        const closed: number[] = [];
        let original: Busy | undefined;
        let persisted: Error | undefined;
        const step: NativeWorkflowStep = {
          ...nativeStep,
          do: (_name, _config, callback) =>
            callback({ ...attempt, attempt: 1 }).catch(() =>
              callback({ ...attempt, attempt: 2 }).catch((error) => {
                if (!(error instanceof Error)) throw error;
                persisted = new Error(error.message);
                throw persisted;
              }),
            ),
        };
        const workflow: WorkflowExport = {
          kind: "Celld.WorkflowExport",
          run: () =>
            task(
              "failure",
              Effect.gen(function* () {
                const scope = yield* Scope.Scope;
                expect(scopes.includes(scope)).toBe(false);
                scopes.push(scope);
                const { attempt } = yield* WorkflowStepContext;
                expect(closed).toHaveLength(attempt - 1);
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    closed.push(attempt);
                  }),
                );
                original = new Busy({ attempt });
                return yield* Effect.fail(original);
              }),
            ).pipe(Effect.catchTag("Busy", Effect.succeed)),
        };
        expect(yield* runWorkflow(workflow, event, step, {}, context)).toBe(
          original,
        );
        expect(closed).toEqual([1, 2]);
        const replay = yield* runWorkflow(
          workflow,
          event,
          {
            ...nativeStep,
            do: () => Effect.runPromise(Effect.die(persisted)),
          },
          {},
          context,
        );
        expect(replay).toMatchObject({ _tag: "Busy", attempt: 2 });
        expect(replay).not.toBe(original);
        expect(closed).toEqual([1, 2]);
      }),
  );

  test.live("workflow native step controls remain defects", () =>
    Effect.gen(function* () {
      const error = new Error("Aborting engine: User called pause");
      const reject = () => Effect.runPromise(Effect.die(error));
      for (const effect of [
        task("task", Effect.succeed(1)),
        sleep("sleep", 1),
        sleepUntil("until", 1),
        waitForEvent("event", { type: "event" }),
      ]) {
        const exit = yield* runWorkflow(
          {
            kind: "Celld.WorkflowExport",
            run: () => effect,
          },
          event,
          {
            do: reject,
            sleep: reject,
            sleepUntil: reject,
            waitForEvent: reject,
          },
          {},
          context,
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true);
          expect(Cause.squash(exit.cause)).toBe(error);
        }
      }
    }),
  );

  test.live(
    "workflow clients forward all v0.5 controls and preserve batch results",
    () =>
      Effect.gen(function* () {
        const calls: unknown[] = [];
        const unit = (...args: unknown[]) =>
          Effect.runPromise(
            Effect.sync(() => {
              calls.push(args);
            }),
          );
        const instance: NativeWorkflowInstance<string> = {
          id: "one",
          status: () =>
            Effect.runPromise(
              Effect.succeed({ status: "complete", output: "ok" }),
            ),
          pause: () => unit("pause"),
          resume: () => unit("resume"),
          restart: (options) => unit("restart", options),
          terminate: () => unit("terminate"),
          sendEvent: (input) => unit("event", input),
          delete: () => unit("delete"),
        };
        let reads = 0;
        const binding: NativeWorkflow<unknown, string> = {
          create: (options) => unit("create", options).then(() => instance),
          createBatch: (options) =>
            unit("batch", options).then(() => [instance]),
          get: (id) => unit("get", id).then(() => instance),
          deleteBatch: (ids) =>
            unit("deleteBatch", ids).then(() => ({
              deleted: [{ id: "one" }],
              errors: [
                {
                  id: "missing",
                  code: 10400,
                  message: "workflows.api.error.instance.not_found",
                },
              ],
            })),
        };
        const handle = makeWorkflowHandle("Test", () => {
          reads++;
          return binding;
        });
        expect(reads).toBe(0);
        yield* Effect.gen(function* () {
          const created = yield* handle.create({
            id: "one",
            params: { x: 1 },
            retention: { successRetention: "1 day" },
            locationHint: "wnam",
          });
          expect(
            (yield* handle.createBatch([{ id: "one" }, { id: "two" }])).length,
          ).toBe(1);
          const found = yield* handle.get("one");
          expect(yield* found.status()).toEqual({
            status: "complete",
            output: "ok",
          });
          yield* created.pause();
          yield* created.resume();
          yield* created.restart({
            from: { name: "approval", count: 2, type: "waitForEvent" },
          });
          yield* created.sendEvent({ type: "approval", payload: true });
          yield* created.terminate();
          yield* created.delete();
          expect(
            (yield* handle.deleteBatch(["one", "missing"])).errors[0].code,
          ).toBe(10400);
        }).pipe(Effect.provide(runtime));
        expect(calls).toContainEqual([
          "restart",
          { from: { name: "approval", count: 2, type: "waitForEvent" } },
        ]);
        expect(calls).toContainEqual(["terminate"]);
        expect(reads).toBe(4);
      }),
  );

  test.live(
    "registered listeners filter queues and record queue, DLQ and cron metadata",
    () =>
      Effect.gen(function* () {
        const rc = makeWorkerRuntimeContext("events");
        const metadata: unknown[] = [];
        const observed: unknown[] = [];
        const host = {
          LogicalId: "events",
          bind: (_name: string, data: unknown) =>
            Effect.sync(() => {
              metadata.push(data);
            }),
        } as unknown as Effect.Success<typeof Worker>;
        const queue = (name: string) =>
          ({
            LogicalId: name,
            FQN: `test.${name}`,
            queueName: Effect.succeed(Effect.succeed(name)),
            fleetId: "fleet",
            fleetUrl: "http://fleet",
          }) as unknown as Queue;
        const jobs = queue("jobs");
        const failed = queue("failed");
        yield* Effect.gen(function* () {
          yield* consumeQueueMessages<string>(
            jobs,
            { deadLetterQueue: failed },
            (messages) =>
              Stream.runForEach(messages, (message) =>
                Effect.sync(() => {
                  observed.push(message.body);
                }),
              ),
          );
          yield* cron("0 * * * *", (input) =>
            Effect.sync(() => {
              observed.push(input.scheduledTime);
            }),
          );
          const handlers: Record<
            "queue" | "scheduled",
            (
              input: unknown,
              env: Record<string, unknown>,
              ctx: unknown,
            ) => readonly [
              Effect.Effect<unknown, never, RuntimeContext | Scope.Scope>,
              Context.Context<never>,
            ]
          > = (yield* rc.exports).default;
          const current = batch();
          const [matched, captured] = handlers.queue(current.value, {}, {});
          yield* matched.pipe(Effect.provide(captured));
          const [ignored, otherContext] = handlers.queue(
            { ...current.value, queue: "another" },
            {},
            {},
          );
          yield* ignored.pipe(Effect.provide(otherContext));
          const [scheduled, scheduleContext] = handlers.scheduled(
            { cron: "0 * * * *", scheduledTime: 123, noRetry() {} },
            {},
            {},
          );
          yield* scheduled.pipe(Effect.provide(scheduleContext));
        }).pipe(
          Effect.provide(
            Layer.mergeAll(EventSourceLive, CronEventSourceLive).pipe(
              Layer.provideMerge(
                Layer.mergeAll(
                  Layer.succeed(Host, host),
                  Layer.succeed(RuntimeContext, rc),
                ),
              ),
            ),
          ),
        );
        expect(observed).toEqual(["a", "b", "c", 123]);
        expect(metadata).toContainEqual({ crons: ["0 * * * *"] });
        expect(metadata[0]).toMatchObject({
          storageBindings: [
            {
              resource: "test.jobs",
              fleetId: "fleet",
              fleetUrl: "http://fleet",
            },
            {
              resource: "test.failed",
              fleetId: "fleet",
              fleetUrl: "http://fleet",
            },
          ],
          queueConsumers: [
            { queue: jobs.queueName, deadLetterQueue: failed.queueName },
          ],
        });
      }),
  );

  test.live(
    "two-phase Workflow declarations register native metadata without native I/O",
    () =>
      Effect.gen(function* () {
        const rc = makeWorkerRuntimeContext("workflow-registration");
        const bindings: unknown[] = [];
        const host = {
          LogicalId: "workflow-registration",
          bind: () => (data: unknown) =>
            Effect.sync(() => {
              bindings.push(data);
            }),
          export: rc.export,
        } as unknown as Effect.Success<typeof Worker>;
        class Reports extends Workflow<Reports>()(
          "Reports",
          Effect.succeed((input: { value: number }) =>
            task("record", Effect.succeed(input.value)),
          ),
        ) {}
        const handle = yield* Reports.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(Host, host),
              Layer.succeed(WorkerEnvironment, {}),
            ),
          ),
        );
        expect(handle.Type).toBe("Celld.Workflow");
        expect(bindings).toEqual([
          {
            bindings: [
              {
                type: "workflow",
                name: "Reports",
                workflowName: "Reports",
                className: "Reports",
              },
            ],
          },
        ]);
        const exports = yield* rc.exports;
        expect(isWorkflowExport(exports.Reports)).toBe(true);
        expect(
          yield* runWorkflow(exports.Reports, event, nativeStep, {}, context),
        ).toBe(42);
      }),
  );

  test.live(
    "NonRetryableError reaches the native task callback unchanged",
    () =>
      Effect.gen(function* () {
        const error = new NonRetryableError("stop");
        let observed: unknown;
        const step: NativeWorkflowStep = {
          ...nativeStep,
          do: (_name, _config, callback) =>
            callback(attempt).catch((cause) => {
              observed = cause;
              throw cause;
            }),
        };
        const workflow: WorkflowExport = {
          kind: "Celld.WorkflowExport",
          run: () => task("fail", Effect.fail(error)),
        };
        const exit = yield* runWorkflow(
          workflow,
          event,
          step,
          {},
          context,
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(observed).toBe(error);
      }),
  );

  test.live(
    "bootstrap workflow classes reflect run without starting I/O in constructors",
    () =>
      Effect.gen(function* () {
        class Base {
          constructor(
            readonly ctx: unknown,
            readonly env: unknown,
          ) {}
        }
        class WorkflowBase extends Base {
          run(): Promise<unknown> {
            return Effect.runPromise(Effect.die("unimplemented base"));
          }
        }
        let builds = 0;
        const workflow: WorkflowExport = {
          kind: "Celld.WorkflowExport",
          run: (input) => Effect.succeed(input),
        };
        const entrypoint = Effect.sync(() => {
          builds++;
          return {
            RuntimeContext: {
              shape: () => ({}),
              exports: Effect.succeed({ Reports: workflow, default: {} }),
            },
          };
        });
        const stack = { name: "workflow-bootstrap", stage: "test" };
        getSharedBuild(entrypoint, stack, {
          platform: runtime,
          env: Effect.succeed({}),
        });
        const fleet = makeFleetBootstrap(
          {
            WorkerEntrypoint: Base as unknown as typeof WorkerEntrypoint,
            DurableObject: Base as unknown as typeof DurableObject,
            WorkflowEntrypoint: WorkflowBase,
          },
          entrypoint,
          { stack },
        );
        const Reports = fleet.workflow("Reports");
        expect(typeof Reports.prototype.run).toBe("function");
        const instance = new Reports({}, {});
        expect(builds).toBe(0);
        expect(
          yield* Effect.promise(() => instance.run(event, nativeStep)),
        ).toEqual({ value: 42 });
        expect(
          yield* Effect.promise(() =>
            new Reports({}, {}).run(event, nativeStep),
          ),
        ).toEqual({ value: 42 });
        expect(builds).toBe(1);
        expect(typeof fleet.default.queue).toBe("function");
        expect(typeof fleet.default.scheduled).toBe("function");
      }),
  );

  test.live(
    "native queue and scheduled forwarding bypasses gateway auth and selects each worker",
    () =>
      Effect.gen(function* () {
        class Base {
          constructor(
            readonly ctx: unknown,
            readonly env: unknown,
          ) {}
        }
        const observed: unknown[] = [];
        const pending: Promise<unknown>[] = [];
        const ctx = {
          waitUntil: (promise: Promise<unknown>) => {
            pending.push(promise);
          },
        };
        const make = (name: string) => {
          const entrypoint = Effect.succeed({
            RuntimeContext: {
              shape: () => ({}),
              exports: Effect.succeed({
                default: {
                  queue: (input: unknown) => [
                    Effect.sync(() => {
                      observed.push([name, "queue", input]);
                    }),
                    Context.empty(),
                  ],
                  scheduled: (input: unknown) => [
                    Effect.sync(() => {
                      observed.push([name, "scheduled", input]);
                    }),
                    Context.empty(),
                  ],
                },
              }),
            },
          });
          const stack = { name, stage: "runtime" };
          getSharedBuild(entrypoint, stack, {
            platform: runtime,
            env: Effect.succeed({}),
          });
          return makeCelldWorkerBridge(
            Base as unknown as typeof WorkerEntrypoint,
            entrypoint,
            { stack },
          );
        };
        const a = make("a");
        const b = make("b");
        yield* Effect.promise(() => a.queue("batch-a", {}, ctx));
        yield* Effect.promise(() => b.queue("batch-b", {}, ctx));
        yield* Effect.promise(() => a.scheduled("cron", {}, ctx));
        expect(observed).toEqual([
          ["a", "queue", "batch-a"],
          ["b", "queue", "batch-b"],
          ["a", "scheduled", "cron"],
        ]);
        yield* Effect.forEach(pending, (promise) =>
          Effect.promise(() => promise),
        );
      }),
  );
});
