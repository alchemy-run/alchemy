import { CallbackError, type Callback } from "@/Callback.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { dispatchCallbacks } from "@/Workers/CallbackDispatcher.ts";
import {
  makeCallbackFactory,
  makeCallbackRegistry,
  openCallbackRegistry,
  type CallbackJob,
  type CallbackStore,
} from "@/Workers/CallbackRegistry.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

const runtime = (id: string): RuntimeContext["Service"] => ({
  Type: "Test.DurableObject",
  id,
  env: {},
  get: () => Effect.succeed(undefined),
  set: (id) => Effect.succeed(id),
});
const services = Layer.succeed(RuntimeContext, runtime("invocation"));

/** Model only the provider-neutral persistence contract, not native transaction behavior. */
const memoryStore = () => {
  const jobs = new Map<string, CallbackJob>();
  const events: string[] = [];
  const key = (job: Pick<CallbackJob, "callback" | "id">) =>
    `${job.callback}:${job.id}`;
  const store: CallbackStore = {
    put: (job) =>
      Effect.sync(() => {
        jobs.set(key(job), job);
      }),
    remove: (callback, id) =>
      Effect.sync(() => {
        jobs.delete(key({ callback, id }));
      }),
    prepare: () => Effect.succeed(true),
    due: (now, limit) =>
      Effect.sync(() =>
        [...jobs.values()].filter((job) => job.runAt <= now).slice(0, limit),
      ),
    claim: (job, retryAt) =>
      Effect.sync(() => {
        if (jobs.get(key(job))?.version !== job.version) return false;
        events.push(`claim:${job.id}`);
        jobs.set(key(job), { ...job, runAt: retryAt });
        return true;
      }),
    acknowledge: (job) =>
      Effect.sync(() => {
        events.push(`ack:${job.id}`);
        if (jobs.get(key(job))?.version === job.version) jobs.delete(key(job));
      }),
    sync: () =>
      Effect.sync(() => {
        events.push("sync");
      }),
    reconcile: () =>
      Effect.sync(() => {
        events.push("reconcile");
      }),
  };
  return { jobs, events, registry: makeCallbackRegistry(store) };
};

class Invocation extends Context.Service<Invocation, string>()(
  "CallbackTest.Invocation",
) {}

describe("shared durable callbacks", () => {
  it.live("validates registration windows, names, delays and schedules", () =>
    Effect.gen(function* () {
      const { registry, jobs } = memoryStore();
      const register = makeCallbackFactory(registry);
      const closed = yield* Effect.exit(register("closed", () => Effect.void));
      expect(
        Exit.isFailure(closed) && Cause.squash(closed.cause),
      ).toBeInstanceOf(CallbackError);
      const seal = openCallbackRegistry(registry);
      for (const [name, delay] of [
        ["", 1],
        ["zero", 0],
        ["infinite", Infinity],
      ] as const) {
        const exit = yield* Effect.exit(
          register(name, () => Effect.void, { retry: { delay } }),
        );
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(
          CallbackError,
        );
      }
      const callback = yield* register("job", (_: unknown) => Effect.void);
      const duplicate = yield* Effect.exit(register("job", () => Effect.void));
      expect(Exit.isFailure(duplicate)).toBe(true);
      seal();
      const late = yield* Effect.exit(register("late", () => Effect.void));
      expect(Exit.isFailure(late)).toBe(true);
      for (const [id, after, payload] of [
        ["", 0, null],
        ["negative", -1, null],
        ["non-json", 0, undefined],
      ] as const) {
        const result = yield* Effect.exit(
          callback.schedule(id, { after, payload }),
        );
        expect(
          Exit.isFailure(result) && Cause.squash(result.cause),
        ).toBeInstanceOf(CallbackError);
      }
      expect(jobs.size).toBe(0);
      yield* callback.schedule("valid", {
        at: new Date(1),
        payload: { value: 1 },
      });
      expect(jobs.size).toBe(1);
      yield* callback.cancel("valid");
      yield* callback.cancel("absent");
      expect(jobs.size).toBe(0);
    }).pipe(Effect.provide(services)),
  );

  it.live(
    "persists recovery before delivery and does not acknowledge same-ID replacements",
    () =>
      Effect.gen(function* () {
        const { registry, jobs, events } = memoryStore();
        const seal = openCallbackRegistry(registry);
        const callback: Callback<number> = yield* makeCallbackFactory(registry)(
          "job",
          (value: number) =>
            Effect.gen(function* () {
              expect(events.slice(-2)).toEqual(["claim:id", "sync"]);
              expect(jobs.get("job:id")!.runAt).toBeGreaterThan(1);
              if (value === 1)
                yield* callback.schedule("id", { at: 1, payload: 2 });
              events.push(`handler:${value}`);
            }),
        );
        seal();
        yield* callback.schedule("id", { at: 1, payload: 1 });
        yield* dispatchCallbacks(registry);
        expect(JSON.parse(jobs.get("job:id")!.payload)).toBe(2);
        yield* dispatchCallbacks(registry);
        expect(jobs.size).toBe(0);
        expect(events.filter((event) => event.startsWith("handler:"))).toEqual([
          "handler:1",
          "handler:2",
        ]);
      }).pipe(Effect.provide(services)),
  );

  it.live(
    "retains failed and unknown jobs but continues bounded backlog delivery",
    () =>
      Effect.gen(function* () {
        const { registry, jobs, events } = memoryStore();
        const seal = openCallbackRegistry(registry);
        const callback = yield* makeCallbackFactory(registry)(
          "job",
          (value: number) => (value === 0 ? Effect.fail("retry") : Effect.void),
        );
        seal();
        for (let i = 0; i < 105; i++)
          yield* callback.schedule(String(i), { at: 1, payload: i });
        yield* dispatchCallbacks(registry);
        expect(jobs.size).toBe(6);
        expect(
          events.filter((event) => event.startsWith("claim:")),
        ).toHaveLength(100);
        expect(events.at(-1)).toBe("reconcile");
        yield* dispatchCallbacks(registry);
        expect(jobs.size).toBe(1);
        jobs.set("missing:id", {
          callback: "missing",
          id: "id",
          version: "v1",
          runAt: 1,
          payload: "null",
        });
        yield* dispatchCallbacks(registry);
        expect(jobs.get("missing:id")!.runAt).toBeGreaterThan(1);
      }).pipe(Effect.provide(services)),
  );

  it.live(
    "supplies a fresh invocation context and scope and waits for callback finalizers",
    () =>
      Effect.gen(function* () {
        const { registry, events } = memoryStore();
        const isolated = makeCallbackRegistry(registry.store, (context) =>
          context.pipe(Context.omit(Invocation)),
        );
        const seal = openCallbackRegistry(isolated);
        const scopes: Scope.Scope[] = [];
        const callback = yield* makeCallbackFactory(isolated)("job", () =>
          Effect.gen(function* () {
            expect((yield* RuntimeContext).id).toBe("invocation");
            expect(yield* Invocation).toBe("fresh");
            scopes.push(yield* Effect.scope);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                events.push("finalized");
              }),
            );
          }),
        ).pipe(
          Effect.provideService(RuntimeContext, runtime("init")),
          Effect.provideService(Invocation, "stale"),
        );
        seal();
        for (const id of ["first", "second"]) {
          yield* callback.schedule(id, { at: 1, payload: null });
          yield* dispatchCallbacks(isolated).pipe(
            Effect.provideService(Invocation, "fresh"),
          );
          expect(events.lastIndexOf("finalized")).toBeLessThan(
            events.indexOf(`ack:${id}`),
          );
        }
        expect(scopes[0]).not.toBe(scopes[1]);
      }).pipe(Effect.provide(services)),
  );

  it.live(
    "propagates interruption after persisting recovery without acknowledging",
    () =>
      Effect.gen(function* () {
        const { registry, jobs, events } = memoryStore();
        const seal = openCallbackRegistry(registry);
        const callback = yield* makeCallbackFactory(registry)(
          "job",
          () => Effect.interrupt,
        );
        seal();
        yield* callback.schedule("id", { at: 1, payload: null });
        const result = yield* Effect.exit(dispatchCallbacks(registry));
        expect(
          Exit.isFailure(result) && Cause.hasInterrupts(result.cause),
        ).toBe(true);
        expect(jobs.get("job:id")!.runAt).toBeGreaterThan(1);
        expect(events).toEqual(["claim:id", "sync"]);
      }).pipe(Effect.provide(services)),
  );
});
