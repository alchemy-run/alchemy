import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Aggregate from "./Aggregate.ts";
import * as Domain from "./Domain.ts";
import type * as Feed from "./Feed.ts";
import * as InMemory from "./InMemory.ts";
import type * as Port from "./Port.ts";
import type * as View from "./View.ts";

/**
 * A failed story expectation.
 */
export class StoryFailure extends Data.TaggedError("StoryFailure")<{
  readonly step: number;
  readonly message: string;
}> {}

/** Marker for "the view key does not exist". */
const none: unique symbol = Symbol.for("alchemy/Fold/Story.none") as any;

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
      readonly _tag: "Feed";
      readonly feed: Feed.Any;
      readonly key: Aggregate.Ref;
      readonly expected: unknown;
    }
  | { readonly _tag: "ExpectCall"; readonly op: Port.Op; readonly args: unknown }
  | { readonly _tag: "Resolve"; readonly op: Port.Op; readonly value: unknown }
  | { readonly _tag: "Clock"; readonly at: string | number };

/** History: events already committed on a stream before the story starts. */
const given = <A extends Aggregate.Any>(
  ref: Aggregate.Ref<A>,
  ...events: ReadonlyArray<Aggregate.EventOf<A>>
): Step => ({
  _tag: "Given",
  ref,
  events: events as ReadonlyArray<{ readonly _tag: string }>,
});

/** Send a command. Its policies run until they finish or suspend on a Port call. */
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

/** Assert on a feed key's entries: expected (partial) entries in order, or a function. */
const feed = <F extends Feed.Any>(
  feed: F,
  key: Aggregate.Ref<F["definition"]["key"]>,
  expected:
    | ReadonlyArray<Partial<Feed.EntryOf<F>>>
    | ((entries: ReadonlyArray<Feed.EntryOf<F>>) => void),
): Step => ({ _tag: "Feed", feed, key, expected });

/** A policy called this Port operation with these (partial) arguments and is waiting. */
const expectCall = <Args>(op: Port.Op<Args, any>, args: Partial<Args>): Step => ({
  _tag: "ExpectCall",
  op,
  args,
});

/** Complete the oldest pending call to this Port operation. */
const resolve = <Success>(op: Port.Op<any, Success>, value: Success): Step => ({
  _tag: "Resolve",
  op,
  value,
});

/** Set the time used for subsequent commands. */
const clock = (at: string | number): Step => ({ _tag: "Clock", at });

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
  readonly port: string;
  readonly op: string;
  readonly args: unknown;
  readonly deferred: Deferred.Deferred<unknown>;
  expected: boolean;
}

/**
 * Create a story runner for a Domain. A story is a sequence of steps run
 * against an in-memory host: policies run for real, Port calls suspend until
 * `resolve`, and nothing outside the Domain is executed.
 *
 * **Example:** A story
 * ```typescript
 * const story = Story.make(Bank, { layer: BankPolicies, ports: [FraudCheck, Payments] });
 *
 * it.effect("withdraw replies with the new balance", () =>
 *   story(
 *     Story.given(a1, new AccountOpened({ ... }), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
 *     Story.when(a1, new Withdraw({ amount: 30, by: sam })),
 *     Story.then(a1, new MoneyWithdrawn({ amount: 30, balanceAfter: 70 })),
 *     Story.replied({ balance: 70 }),
 *   ),
 * );
 * ```
 */
const make =
  <Name extends string, Provided, Policies, LE = never, LR = never, Ports extends Port.Any = never>(
    domain: Domain.DomainClass<Name, Provided, Policies>,
    options: {
      /** Layers for the Domain's policies. */
      readonly layer?: Layer.Layer<Policies, LE, LR>;
      /** Ports the policies call. Each is replaced by a scripted implementation. */
      readonly ports?: ReadonlyArray<Ports>;
    } = {},
  ) =>
  (
    ...steps: ReadonlyArray<Step>
  ): Effect.Effect<void, StoryFailure | LE, Exclude<LR, Provided | Port.Identifier<Ports>>> =>
    Effect.gen(function* () {
      const clockState = { now: Date.parse("2026-01-01T00:00:00.000Z") };
      const platform = InMemory.make({ manual: true, now: () => clockState.now });
      const calls: Array<PendingCall> = [];
      const portLayers = (options.ports ?? []).map((port) =>
        Layer.succeed(
          port as Context.Key<unknown, unknown>,
          Object.fromEntries(
            Object.keys(port.ops).map((op) => [
              op,
              (args: unknown) =>
                platform.control.suspended(
                  Effect.gen(function* () {
                    const deferred = yield* Deferred.make<unknown>();
                    calls.push({ port: port.portName, op, args, deferred, expected: false });
                    return yield* Deferred.await(deferred);
                  }),
                ),
            ]),
          ),
        ),
      );
      const ports = Layer.mergeAll(Layer.empty, ...portLayers);
      const policies = (
        options.layer ?? (Layer.empty as unknown as Layer.Layer<Policies, LE, LR>)
      ).pipe(Layer.provide(ports));
      const hosted = domain
        .layer(policies)
        .pipe(Layer.provide(Layer.mergeAll(platform.layer, ports)));

      const run = Effect.gen(function* () {
        const internals = yield* Domain.Internals;
        const cursors = new Map<string, number>();
        let last:
          | { readonly _tag: "Accepted"; readonly receipt: Aggregate.Receipt }
          | { readonly _tag: "Rejected"; readonly rejection: { readonly _tag: string } }
          | undefined;
        let unassertedRejection: { readonly step: number; readonly tag: string } | undefined;

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
                      message: `a policy failed: ${String(platform.control.failures[0])}`,
                    });
                  }
                  return;
                }
              }
            }
            return yield* new StoryFailure({
              step,
              message: "the domain did not settle (a policy is looping?)",
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
              clockState.now = typeof s.at === "number" ? s.at : Date.parse(s.at);
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
                .pipe(Effect.result);
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
                View.Host<unknown, Aggregate.Any>
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
            case "Feed": {
              const host = yield* s.feed as unknown as Context.Key<
                never,
                Feed.Host<unknown, Aggregate.Any>
              >;
              const { entries } = yield* host.list(s.key);
              if (typeof s.expected === "function") {
                const assert = s.expected as (entries: ReadonlyArray<unknown>) => void;
                yield* Effect.try({ try: () => assert(entries), catch: (e) => fail(String(e)) });
              } else {
                const expected = s.expected as ReadonlyArray<unknown>;
                const ok =
                  expected.length === entries.length &&
                  expected.every((e, i) => partial(e, entries[i]));
                if (!ok)
                  return yield* fail(
                    `${s.feed.feedName}(${s.key.id})\n  expected ${show(expected)}\n  actual   ${show(entries)}`,
                  );
              }
              break;
            }
            case "ExpectCall": {
              const call = calls.find(
                (c) => c.port === s.op.port && c.op === s.op.op && !c.expected,
              );
              if (!call) {
                return yield* fail(
                  `no pending call to ${s.op.port}.${s.op.op}; pending: ${show(calls.map((c) => `${c.port}.${c.op}`))}`,
                );
              }
              if (!partial(s.args, call.args)) {
                return yield* fail(
                  `${s.op.port}.${s.op.op} was called with ${show(call.args)}, expected ${show(s.args)}`,
                );
              }
              call.expected = true;
              break;
            }
            case "Resolve": {
              const index = calls.findIndex((c) => c.port === s.op.port && c.op === s.op.op);
              if (index === -1) return yield* fail(`no pending call to ${s.op.port}.${s.op.op}`);
              const [call] = calls.splice(index, 1);
              yield* Deferred.succeed(call!.deferred, s.value);
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
        if (calls.length > 0) {
          return yield* new StoryFailure({
            step: steps.length,
            message: `unresolved Port calls at the end of the story: ${show(calls.map((c) => `${c.port}.${c.op}(${show(c.args)})`))}`,
          });
        }
      });

      // `hosted` satisfies the Domain, the platform and the scripted Ports; what
      // remains is whatever the policy Layers need from outside (`LR`'s rest).
      return yield* run.pipe(Effect.provide(hosted));
    }) as Effect.Effect<void, StoryFailure | LE, Exclude<LR, Provided | Port.Identifier<Ports>>>;

/**
 * Stories: given / when / then specifications of a Domain, run against an
 * in-memory host. Policies run for real, Port calls suspend until resolved,
 * and nothing outside the Domain is executed.
 *
 * The steps live on this object rather than as module exports: a module that
 * exports `then` is "thenable", and loaders that await module namespaces
 * would hang on it.
 */
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
  feed,
  expectCall,
  resolve,
  clock,
  /** Marker for "the view key does not exist". */
  none,
} as const;
