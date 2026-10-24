import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { DurableDeferred, WorkflowEngine } from "effect/workflow";
import * as Aggregate from "./Aggregate.ts";
import * as ExternalSystem from "./ExternalSystem.ts";
import * as InMemory from "./InMemory.ts";
import * as Model from "./Model.ts";
import type * as Saga from "./Saga.ts";
import type * as DomainStream from "./Stream.ts";
import type * as View from "./View.ts";

/**
 * A failed story expectation.
 */
export class StoryFailure extends Data.TaggedError("StoryFailure")<{
  readonly step: number;
  readonly message: string;
}> {}

/** Marker for "the view key does not exist". */
const none: unique symbol = Symbol.for("alchemy/Domain/Story.none") as any;

/**
 * One step of a story. Build steps with the step constructors in this module.
 */
export type Step =
  | {
      readonly _tag: "Given";
      readonly ref: Aggregate.Ref;
      readonly events: ReadonlyArray<{ readonly _tag: string }>;
    }
  | {
      readonly _tag: "When";
      readonly ref: Aggregate.Ref;
      readonly command: { readonly _tag: string };
      readonly commandId?: string;
    }
  | {
      readonly _tag: "Then";
      readonly ref: Aggregate.Ref;
      readonly events: ReadonlyArray<{ readonly _tag: string }>;
    }
  | { readonly _tag: "Rejected"; readonly rejection: { readonly _tag: string } }
  | { readonly _tag: "Replied"; readonly reply: unknown }
  | { readonly _tag: "State"; readonly ref: Aggregate.Ref; readonly assert: (state: any) => void }
  | {
      readonly _tag: "View";
      readonly view: View.Any;
      readonly key: Aggregate.Ref;
      readonly expected: unknown;
    }
  | {
      readonly _tag: "Emitted";
      readonly view: View.Any;
      readonly key: Aggregate.Ref;
      readonly expected: unknown;
    }
  | {
      readonly _tag: "Streamed";
      readonly stream: DomainStream.Any;
      readonly key: Aggregate.Ref;
      readonly events: ReadonlyArray<{ readonly _tag: string }>;
    }
  | {
      readonly _tag: "ExpectCall";
      readonly tag: string | undefined;
      readonly op: ExternalSystem.Op;
      readonly args: unknown;
    }
  | {
      readonly _tag: "Resolve";
      readonly tag: string | undefined;
      readonly op: ExternalSystem.Op;
      readonly exit: Exit.Exit<unknown, unknown>;
    }
  | { readonly _tag: "Clock"; readonly at: string | number | DateTime.DateTime }
  | {
      readonly _tag: "Signal";
      readonly saga: Saga.Any;
      readonly key: unknown;
      readonly deferred: DurableDeferred.Any;
      readonly value: unknown;
    }
  | {
      readonly _tag: "Saga";
      readonly saga: Saga.Any;
      readonly key: unknown;
      readonly expected: Saga.Status<unknown, unknown> | { readonly _tag: "Died" };
    }
  | {
      readonly _tag: "Provide";
      readonly service: Context.Key<unknown, unknown>;
      readonly value: unknown;
    };

/** History: events already committed on a stream before the story starts. */
const given = <A extends Aggregate.Any>(
  ref: Aggregate.Ref<A>,
  ...events: ReadonlyArray<Aggregate.EventOf<A>>
): Step => ({
  _tag: "Given",
  ref,
  events: events as ReadonlyArray<{ readonly _tag: string }>,
});

/** Send a command. Its policies run until they finish or suspend on an external system call. */
const when = <A extends Aggregate.Any>(
  ref: Aggregate.Ref<A>,
  command: Aggregate.CommandOf<A>,
  options?: { readonly commandId?: string },
): Step => ({
  _tag: "When",
  ref,
  command: command as { readonly _tag: string },
  commandId: options?.commandId,
});

/** The next events committed on a stream. With no events: nothing new was committed. */
const then = <A extends Aggregate.Any>(
  ref: Aggregate.Ref<A>,
  ...events: ReadonlyArray<Aggregate.EventOf<A>>
): Step => ({
  _tag: "Then",
  ref,
  events: events as ReadonlyArray<{ readonly _tag: string }>,
});

/** The last command was rejected with exactly this rejection. */
const rejected = (rejection: { readonly _tag: string }): Step => ({
  _tag: "Rejected",
  rejection,
});

/** The last command's reply. */
const replied = (reply: unknown): Step => ({ _tag: "Replied", reply });

/** Assert on an aggregate instance's current state. */
const state = <A extends Aggregate.Any>(
  ref: Aggregate.Ref<A>,
  assert: (state: Aggregate.StateOf<A>) => void,
): Step => ({
  _tag: "State",
  ref,
  assert,
});

/** Assert on a view key: an expected (partial) state, a function, or {@link none}. */
const view = <V extends View.Any>(
  view: V,
  key: Aggregate.Ref<View.KeyOf<V>>,
  expected: Partial<View.StateOf<V>> | ((state: View.StateOf<V>) => void) | typeof none,
): Step => ({ _tag: "View", view, key, expected });

/**
 * Assert on every event a view key has emitted: the expected (partial) events
 * in order, or a function over the entries (each event with the state after it).
 */
const emitted = <V extends View.Any>(
  view: V,
  key: Aggregate.Ref<View.KeyOf<V>>,
  expected:
    | ReadonlyArray<Partial<View.EventOf<V>>>
    | ((entries: ReadonlyArray<View.Entry<View.StateOf<V>, View.EventOf<V>>>) => void),
): Step => ({ _tag: "Emitted", view, key, expected });

/**
 * The next entries appended to a stream key (by its projection). With no
 * events: nothing new was appended.
 */
const streamed = <S extends DomainStream.Any>(
  stream: S,
  key: Aggregate.Ref<DomainStream.KeyOf<S>>,
  ...events: ReadonlyArray<DomainStream.EventOf<S>>
): Step => ({
  _tag: "Streamed",
  stream,
  key,
  events: events as ReadonlyArray<{ readonly _tag: string }>,
});

/**
 * An external system call matching these (partial) arguments is waiting.
 * With a tag first, the tag names that call, so a later `resolve` can answer
 * exactly it; when several match, it names the earliest one made.
 */
const expectCall: {
  <Args>(op: ExternalSystem.Op<Args, any>, args: Partial<Args>): Step;
  <Args>(tag: string, op: ExternalSystem.Op<Args, any>, args: Partial<Args>): Step;
} = (...a: ReadonlyArray<any>): Step =>
  typeof a[0] === "string"
    ? { _tag: "ExpectCall", tag: a[0], op: a[1], args: a[2] }
    : { _tag: "ExpectCall", tag: undefined, op: a[0], args: a[1] };

/** Answer a pending call with an exit; the tag, when given, comes first. */
const answer = (a: ReadonlyArray<any>, exit: (value: any) => Exit.Exit<unknown, unknown>): Step =>
  typeof a[0] === "string"
    ? { _tag: "Resolve", tag: a[0], op: a[1], exit: exit(a[2]) }
    : { _tag: "Resolve", tag: undefined, op: a[0], exit: exit(a[1]) };

/**
 * Answer an external system call. With a tag first, answers the call
 * `expectCall` tagged; without one, answers the only pending call to the
 * operation, and fails if several are pending.
 */
const resolve: {
  <Success>(op: ExternalSystem.Op<any, Success>, value: Success): Step;
  <Success>(tag: string, op: ExternalSystem.Op<any, Success>, value: Success): Step;
} = (...a: ReadonlyArray<any>): Step => answer(a, Exit.succeed);

/**
 * Fail an external system call with one of the operation's declared errors,
 * as when the vendor refuses. Finds the call the same way `resolve` does.
 */
const fail: {
  <Error>(op: ExternalSystem.Op<any, any, Error>, error: NoInfer<Error>): Step;
  <Error>(tag: string, op: ExternalSystem.Op<any, any, Error>, error: NoInfer<Error>): Step;
} = (...a: ReadonlyArray<any>): Step => answer(a, Exit.fail);

/**
 * Fail an external system call with a defect, as when the transport breaks.
 * Finds the call the same way `resolve` does.
 */
const die: {
  (op: ExternalSystem.Op, defect: unknown): Step;
  (tag: string, op: ExternalSystem.Op, defect: unknown): Step;
} = (...a: ReadonlyArray<any>): Step => answer(a, Exit.die);

/** Move the clock: later commands are stamped with it, and scheduled commands now due fire. */
const clock = (at: string | number | DateTime.DateTime): Step => ({ _tag: "Clock", at });

type SagaClientOf<S> = S extends Context.Key<any, infer C> ? C : never;
type SagaKeyOf<S> =
  SagaClientOf<S> extends Saga.Client<infer K, any, any, any> ? K | { readonly id: K } : never;
type SagaStatusOf<S> =
  SagaClientOf<S> extends Saga.Client<any, any, infer A, infer E> ? Saga.Status<A, E> : never;

/** Complete a `DurableDeferred` a saga run waits on, then let it run. */
const signal = <S extends Saga.Any, Success extends Schema.Constraint>(
  saga: S,
  key: SagaKeyOf<S>,
  deferred: DurableDeferred.DurableDeferred<Success, any>,
  value: Success["Type"],
): Step => ({ _tag: "Signal", saga, key, deferred, value });

/**
 * Check where a saga run is: running, completed with a result, rejected,
 * interrupted, or died. `{ _tag: "Died" }` matches any defect; with a
 * `defect`, it must read the same.
 */
const saga = <S extends Saga.Any>(
  saga: S,
  key: SagaKeyOf<S>,
  expected: SagaStatusOf<S> | { readonly _tag: "Died" },
): Step => ({
  _tag: "Saga",
  saga,
  key,
  expected: expected as Saga.Status<unknown, unknown>,
});

/** A saga status, in a form to compare: rejections encoded, defects as text. */
const statusJson = (status: Saga.Status<unknown, unknown> | { readonly _tag: "Died" }) =>
  status._tag === "Rejected"
    ? { _tag: "Rejected", rejection: encodeInstance(status.rejection as { readonly _tag: string }) }
    : status._tag === "Died"
      ? "defect" in status
        ? { _tag: "Died", defect: String(status.defect) }
        : { _tag: "Died" }
      : status;

/**
 * Provide a service to subsequent commands, as their middleware would (for
 * example the current actor). Replaces any earlier value of the same service.
 */
const provide = <I, S>(service: Context.Key<I, S>, value: S): Step => ({
  _tag: "Provide",
  service: service as unknown as Context.Key<unknown, unknown>,
  value,
});

const normalize = (value: unknown): unknown => {
  if (DateTime.isDateTime(value)) return DateTime.formatIso(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = normalize((value as any)[key]);
    return out;
  }
  return value;
};

const show = (value: unknown) => JSON.stringify(normalize(value));

const encodeInstance = (value: { readonly _tag: string }): unknown => {
  const schema = (value as any).constructor as Schema.Top;
  return Schema.encodeUnknownSync(Schema.toCodecJson(schema as any) as any)(value);
};

const equal = (a: unknown, b: unknown) => show(a) === show(b);

const partial = (expected: unknown, actual: unknown): boolean => {
  const e = normalize(expected);
  const a = normalize(actual);
  if (e !== null && typeof e === "object" && !Array.isArray(e)) {
    if (a === null || typeof a !== "object") return false;
    return Object.keys(e).every((k) => partial((e as any)[k], (a as any)[k]));
  }
  return JSON.stringify(e) === JSON.stringify(a);
};

interface PendingCall {
  readonly system: string;
  readonly op: string;
  readonly args: unknown;
  readonly deferred: Deferred.Deferred<unknown, unknown>;
  /** The name `expectCall` gave it, if any. */
  tag: string | undefined;
}

/** Options for {@link make}. */
interface StoryOptions<Policies, LE, LR, Systems> {
  /** The policies' and projections' Layers. Required when the model has either. */
  readonly layer?: Layer.Layer<Policies, LE, LR>;
  /** External systems the policies call. Each is replaced by a scripted implementation. */
  readonly externalSystems?: ReadonlyArray<Systems>;
}

/**
 * Create a story runner for a Domain. A story is a sequence of steps run
 * against an in-memory host: policies run for real, external system calls suspend until
 * `resolve`, and nothing outside the Domain is executed.
 *
 * **Example:** A story
 * ```typescript
 * const story = Story.make(Bank, {
 *   layer: BankPolicies,
 *   externalSystems: [FraudCheck, Payments],
 * });
 *
 * it.effect("withdraw replies with the new balance", () =>
 *   story(
 *     Story.given(a1, new AccountOpened({ ... }), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
 *     Story.provide(CurrentActor, sam),
 *     Story.when(a1, new WithdrawMoney({ amount: 30 })),
 *     Story.then(a1, new MoneyWithdrawn({ amount: 30, balanceAfter: 70 })),
 *     Story.replied({ balance: 70 }),
 *   ),
 * );
 * ```
 */
const make =
  <
    Name extends string,
    Provided,
    Policies,
    LE = never,
    LR = never,
    Systems extends ExternalSystem.Any = never,
  >(
    domain: Model.ModelClass<Name, Provided, Policies>,
    ...[options = {}]: [Policies] extends [never]
      ? [options?: StoryOptions<Policies, LE, LR, Systems>]
      : [options: StoryOptions<Policies, LE, LR, Systems> & { readonly layer: unknown }]
  ) =>
  (
    ...steps: ReadonlyArray<Step>
  ): Effect.Effect<
    void,
    StoryFailure | LE,
    Exclude<LR, Provided | ExternalSystem.Identifier<Systems> | WorkflowEngine.WorkflowEngine>
  > =>
    Effect.gen(function* () {
      const clockState = { now: Date.parse("2026-01-01T00:00:00.000Z") };
      const platform = InMemory.make({ manual: true, now: () => clockState.now });
      const calls: Array<PendingCall> = [];
      const systemLayers = (options.externalSystems ?? []).map((system) =>
        Layer.succeed(
          system as Context.Key<unknown, unknown>,
          ExternalSystem.observeOps(
            system.systemName,
            Object.fromEntries(
              Object.keys(system.ops).map((op) => [
                op,
                (args: unknown) =>
                  platform.control.suspended(
                    Effect.gen(function* () {
                      const deferred = yield* Deferred.make<unknown, unknown>();
                      calls.push({
                        system: system.systemName,
                        op,
                        args,
                        deferred,
                        tag: undefined,
                      });
                      return yield* Deferred.await(deferred);
                    }),
                  ),
              ]),
            ),
          ) as never,
        ),
      );
      const systems = Layer.mergeAll(Layer.empty, ...systemLayers);
      const policies = (
        options.layer ?? (Layer.empty as unknown as Layer.Layer<Policies, LE, LR>)
      ).pipe(Layer.provide(systems));
      const hosted = domain
        .layer(policies)
        .pipe(Layer.provide(Layer.mergeAll(platform.layer, systems)));

      const run = Effect.gen(function* () {
        const internals = yield* Model.Internals;
        const cursors = new Map<string, number>();
        let last:
          | { readonly _tag: "Accepted"; readonly receipt: Aggregate.Receipt }
          | { readonly _tag: "Rejected"; readonly rejection: { readonly _tag: string } }
          | undefined;
        let unassertedRejection: { readonly step: number; readonly tag: string } | undefined;
        let provided = Context.empty() as Context.Context<unknown>;
        const assertedDeaths = new Set<string>();

        const storeOf = (ref: Aggregate.Ref) => internals.aggregates.get(ref.aggregate)!;
        const committed = (ref: Aggregate.Ref) =>
          storeOf(ref).events?.(ref.id as string) ?? Effect.succeed([]);

        const settle = (step: number) =>
          Effect.gen(function* () {
            for (let i = 0; i < 10_000; i++) {
              yield* platform.control.drain;
              yield* Effect.yieldNow;
              if (yield* platform.control.idle) {
                yield* Effect.yieldNow;
                yield* platform.control.drain;
                if (yield* platform.control.idle) {
                  if (platform.control.failures.length > 0) {
                    return yield* new StoryFailure({
                      step,
                      message: `a policy or projection failed: ${String(platform.control.failures[0])}`,
                    });
                  }
                  return;
                }
              }
            }
            return yield* new StoryFailure({
              step,
              message: "the domain did not settle (a policy or projection is looping?)",
            });
          });

        for (const [index, s] of steps.entries()) {
          const step = index + 1;
          const fail = (message: string) =>
            new StoryFailure({ step, message: `${s._tag}: ${message}` });
          if (unassertedRejection && s._tag !== "Rejected") {
            return yield* new StoryFailure({
              step: unassertedRejection.step,
              message: `the command was rejected with ${unassertedRejection.tag}, which no step asserts`,
            });
          }
          switch (s._tag) {
            case "Clock": {
              clockState.now =
                typeof s.at === "number"
                  ? s.at
                  : typeof s.at === "string"
                    ? Date.parse(s.at)
                    : DateTime.toEpochMillis(s.at);
              // Scheduled commands that are now due fire, and their policies run.
              yield* settle(step);
              break;
            }
            case "Provide": {
              provided = Context.add(provided, s.service, s.value);
              break;
            }
            case "Given": {
              const store = storeOf(s.ref);
              if (!store.seed) return yield* fail("the platform cannot seed events");
              yield* store.seed(
                s.ref.id as string,
                s.events.map((e) => internals.kernel.encodeEvent(e)),
              );
              cursors.set(`${s.ref.aggregate}/${s.ref.id}`, (yield* committed(s.ref)).length);
              yield* settle(step);
              break;
            }
            case "When": {
              const client = yield* Aggregate.refClass(s.ref) as unknown as Context.Key<
                never,
                Aggregate.ClientImpl
              >;
              const result = yield* client
                .send(s.ref, s.command, { commandId: s.commandId ?? `story:${step}` })
                .pipe(Effect.provide(provided), Effect.result);
              if (result._tag === "Success") {
                last = { _tag: "Accepted", receipt: result.success };
              } else {
                last = { _tag: "Rejected", rejection: result.failure as { readonly _tag: string } };
                unassertedRejection = { step, tag: last.rejection._tag };
              }
              yield* settle(step);
              break;
            }
            case "Then": {
              const stream = `${s.ref.aggregate}/${s.ref.id}`;
              const events = yield* committed(s.ref);
              const from = cursors.get(stream) ?? 0;
              const actual = events
                .slice(from, from + Math.max(s.events.length, 1))
                .map((e) => e.event);
              const expected = s.events.map(encodeInstance);
              if (s.events.length === 0) {
                if (events.length > from) {
                  return yield* fail(
                    `expected no new events on ${stream}, got ${show(events.slice(from).map((e) => e.event))}`,
                  );
                }
                break;
              }
              if (!equal(actual.slice(0, expected.length), expected)) {
                return yield* fail(
                  `on ${stream}\n  expected ${show(expected)}\n  actual   ${show(events.slice(from).map((e) => e.event))}`,
                );
              }
              cursors.set(stream, from + expected.length);
              break;
            }
            case "Rejected": {
              if (last?._tag !== "Rejected")
                return yield* fail(
                  `expected a rejection, the command was ${last ? "accepted" : "never sent"}`,
                );
              const expected = encodeInstance(s.rejection);
              const actual = encodeInstance(last.rejection);
              if (!equal(expected, actual))
                return yield* fail(`expected ${show(expected)}, got ${show(actual)}`);
              unassertedRejection = undefined;
              break;
            }
            case "Replied": {
              if (last?._tag !== "Accepted")
                return yield* fail("the last command was not accepted");
              if (!equal(last.receipt.reply, s.reply)) {
                return yield* fail(`expected ${show(s.reply)}, got ${show(last.receipt.reply)}`);
              }
              break;
            }
            case "State": {
              const client = yield* Aggregate.refClass(s.ref) as unknown as Context.Key<
                never,
                Aggregate.ClientImpl
              >;
              const current = yield* client.state(s.ref);
              yield* Effect.try({ try: () => s.assert(current), catch: (e) => fail(String(e)) });
              break;
            }
            case "View": {
              const host = yield* s.view as unknown as Context.Key<
                never,
                View.Host<unknown, Aggregate.Any, unknown>
              >;
              const current = yield* host.query(s.key).pipe(Effect.orDie);
              if (s.expected === none) {
                if (Option.isSome(current))
                  return yield* fail(
                    `expected ${s.view.viewName}(${s.key.id}) to not exist, got ${show(current.value)}`,
                  );
                break;
              }
              if (Option.isNone(current))
                return yield* fail(`${s.view.viewName}(${s.key.id}) does not exist`);
              if (typeof s.expected === "function") {
                const assert = s.expected as (state: unknown) => void;
                yield* Effect.try({
                  try: () => assert(current.value),
                  catch: (e) => fail(String(e)),
                });
              } else if (!partial(s.expected, current.value)) {
                return yield* fail(
                  `${s.view.viewName}(${s.key.id})\n  expected ${show(s.expected)}\n  actual   ${show(current.value)}`,
                );
              }
              break;
            }
            case "Emitted": {
              const host = yield* s.view as unknown as Context.Key<
                never,
                View.Host<unknown, Aggregate.Any, unknown>
              >;
              const { entries } = yield* host.list(s.key);
              if (typeof s.expected === "function") {
                const assert = s.expected as (entries: ReadonlyArray<unknown>) => void;
                yield* Effect.try({ try: () => assert(entries), catch: (e) => fail(String(e)) });
              } else {
                const expected = s.expected as ReadonlyArray<unknown>;
                const events = entries.map((entry) => entry.event);
                const ok =
                  expected.length === events.length &&
                  expected.every((e, i) => partial(e, events[i]));
                if (!ok)
                  return yield* fail(
                    `${s.view.viewName}(${s.key.id})\n  expected ${show(expected)}\n  actual   ${show(events)}`,
                  );
              }
              break;
            }
            case "Streamed": {
              const store = internals.streams.get(s.stream.streamName)!;
              const id = `${s.stream.streamName}/${s.key.id}`;
              const entries = yield* store.list(s.key.id as string);
              const from = cursors.get(id) ?? 0;
              const actual = entries.slice(from).map((e) => e.event);
              const expected = s.events.map(encodeInstance);
              if (s.events.length === 0) {
                if (actual.length > 0)
                  return yield* fail(`expected nothing new on ${id}, got ${show(actual)}`);
                break;
              }
              if (!equal(actual.slice(0, expected.length), expected)) {
                return yield* fail(
                  `on ${id}\n  expected ${show(expected)}\n  actual   ${show(actual)}`,
                );
              }
              cursors.set(id, from + expected.length);
              break;
            }
            case "ExpectCall": {
              const name = `${s.op.system}.${s.op.op}`;
              const pending = calls.filter((c) => c.system === s.op.system && c.op === s.op.op);
              // Calls are kept in the order they were made: a tag names the earliest match.
              const match = pending.find((c) => c.tag === undefined && partial(s.args, c.args));
              if (!match) {
                return yield* fail(
                  `no pending call to ${name} matches ${show(s.args)}; pending: ${show(pending.map((c) => c.args))}`,
                );
              }
              if (s.tag !== undefined) {
                if (calls.some((c) => c.tag === s.tag)) {
                  return yield* fail(`"${s.tag}" already names a pending call`);
                }
                match.tag = s.tag;
              }
              break;
            }
            case "Signal": {
              const client = yield* s.saga as unknown as Context.Key<
                never,
                Saga.Client<unknown, unknown, unknown, unknown>
              >;
              yield* client.get(s.key).signal(s.deferred as never, s.value);
              yield* settle(step);
              break;
            }
            case "Saga": {
              const client = yield* s.saga as unknown as Context.Key<
                never,
                Saga.Client<unknown, unknown, unknown, unknown>
              >;
              const run = client.get(s.key);
              const actual = yield* run.status;
              // `{ _tag: "Died" }` matches any defect.
              const compared =
                actual._tag === "Died" && !("defect" in s.expected)
                  ? { _tag: "Died" as const }
                  : actual;
              if (!equal(statusJson(compared), statusJson(s.expected))) {
                return yield* fail(
                  `${s.saga.sagaName}\n  expected ${show(statusJson(s.expected))}\n  actual   ${show(statusJson(actual))}`,
                );
              }
              if (actual._tag === "Died")
                assertedDeaths.add(`${s.saga.sagaName}/${run.executionId}`);
              break;
            }
            case "Resolve": {
              const name = `${s.op.system}.${s.op.op}`;
              let call: PendingCall | undefined;
              if (s.tag !== undefined) {
                call = calls.find((c) => c.tag === s.tag);
                if (!call) {
                  const tags = calls.flatMap((c) => (c.tag === undefined ? [] : [`"${c.tag}"`]));
                  return yield* fail(
                    `no pending call is named "${s.tag}"; named: ${tags.length > 0 ? tags.join(", ") : "none"}`,
                  );
                }
                if (call.system !== s.op.system || call.op !== s.op.op) {
                  return yield* fail(
                    `"${s.tag}" names a call to ${call.system}.${call.op}, not ${name}`,
                  );
                }
              } else {
                const pending = calls.filter((c) => c.system === s.op.system && c.op === s.op.op);
                if (pending.length === 0) return yield* fail(`no pending call to ${name}`);
                if (pending.length > 1) {
                  return yield* fail(
                    `${pending.length} pending calls to ${name}; name each with expectCall("<tag>", ...) and resolve it by tag`,
                  );
                }
                call = pending[0];
              }
              calls.splice(calls.indexOf(call!), 1);
              yield* Deferred.done(call!.deferred, s.exit);
              yield* settle(step);
              break;
            }
          }
        }
        if (unassertedRejection) {
          return yield* new StoryFailure({
            step: unassertedRejection.step,
            message: `the command was rejected with ${unassertedRejection.tag}, which no step asserts`,
          });
        }
        const death = platform.control.deaths.find(
          ({ saga, executionId }) => !assertedDeaths.has(`${saga}/${executionId}`),
        );
        if (death) {
          return yield* new StoryFailure({
            step: steps.length,
            message: `saga ${death.saga} run ${death.executionId} died with ${String(death.defect)}, which no step asserts`,
          });
        }
        if (calls.length > 0) {
          return yield* new StoryFailure({
            step: steps.length,
            message: `unresolved external system calls at the end of the story: ${show(calls.map((c) => `${c.system}.${c.op}(${show(c.args)})`))}`,
          });
        }
      });

      // `hosted` satisfies the Domain, the platform and the scripted Ports; what
      // remains is whatever the policy Layers need from outside (`LR`'s rest).
      return yield* run.pipe(Effect.provide(hosted));
    }) as Effect.Effect<
      void,
      StoryFailure | LE,
      Exclude<LR, Provided | ExternalSystem.Identifier<Systems> | WorkflowEngine.WorkflowEngine>
    >;

/**
 * Given / when / then specifications of a domain model, run against the real
 * model in memory: policies run for real, external system calls wait until you resolve
 * them, and a clock you control stamps commands and fires scheduled ones. A
 * story fails on any rejection, external system call or saga defect it
 * doesn't account for.
 *
 * ### Writing a story
 * **Example:** A withdrawal and an overdraft
 * ```typescript
 * import { it } from "@effect/vitest";
 * import { Story } from "@alchemy.run/domain/Story";
 * import { Account, InsufficientFunds, MoneyDeposited, MoneyWithdrawn, WithdrawMoney } from "../src/Account.ts";
 * import { Bank, BankPolicies } from "../src/Bank.ts";
 *
 * const story = Story.make(Bank, { layer: BankPolicies });
 * const account = Account.ref("a-1");
 *
 * it.effect("withdraws within the balance, and refuses beyond it", () =>
 *   story(
 *     Story.given(account, new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
 *     Story.when(account, new WithdrawMoney({ amount: 30 })),
 *     Story.then(account, new MoneyWithdrawn({ amount: 30, balanceAfter: 70 })),
 *     Story.replied({ balance: 70 }),
 *     Story.when(account, new WithdrawMoney({ amount: 100 })),
 *     Story.rejected(new InsufficientFunds({ balance: 70, requested: 100 })),
 *   ),
 * );
 * ```
 *
 * ### External systems and the clock
 * **Example:** Answer an external system call, then move the clock
 * ```typescript
 * Story.expectCall(FraudCheck.score, { accountId: account.id, amount: 60_000 }),
 * Story.resolve(FraudCheck.score, { risk: 0.95 }),
 * Story.clock("2026-01-02T09:00:00Z"),
 * ```
 *
 * **Example:** Name calls when several are waiting
 * ```typescript
 * Story.expectCall("a-1", FraudCheck.score, { accountId: a1.id }),
 * Story.expectCall("a-2", FraudCheck.score, { accountId: a2.id }),
 * Story.resolve("a-2", FraudCheck.score, { risk: 0.1 }),
 * Story.resolve("a-1", FraudCheck.score, { risk: 0.95 }),
 * ```
 *
 * **Example:** Fail a call with the operation's declared error, or a defect
 * ```typescript
 * Story.expectCall(LockVendor.deleteCode, { codeId: "pc_1" }),
 * Story.fail(LockVendor.deleteCode, new LockVendorRefused({ reason: "gateway-lost" })),
 * Story.expectCall(LockVendor.deleteCode, { codeId: "pc_2" }),
 * Story.die(LockVendor.deleteCode, new Error("socket closed")),
 * ```
 *
 * ### Sagas
 * **Example:** Check where a saga run is, and send it a signal
 * ```typescript
 * Story.saga(ExecuteTransfer, transfer, { _tag: "Running" }),
 * Story.signal(ExecuteTransfer, transfer, Decision, "approved"),
 * ```
 *
 * @primitive
 */
// The steps live on this object rather than as module exports: a module that
// exports `then` is "thenable", and loaders that await module namespaces
// would hang on it.
// oxlint-disable-next-line unicorn/no-thenable -- `Story.then` is the given/when/then vocabulary
export const Story = {
  make,
  given,
  when,
  then,
  rejected,
  replied,
  state,
  view,
  emitted,
  streamed,
  expectCall,
  resolve,
  fail,
  die,
  clock,
  provide,
  signal,
  saga,
  /** Marker for "the view key does not exist". */
  none,
} as const;
