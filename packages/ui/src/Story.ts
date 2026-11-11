/**
 * Stories test a component through its model: send Intents by name, answer
 * the services it calls, and check its state, its writes, and what it renders.
 * They run the real constructor, handlers and signal graph, without a DOM.
 *
 * ```typescript
 * it.effect("each click counts once", () =>
 *   Story.story(
 *     { component: Hello, layer: HelloLive },
 *     Story.mount(),
 *     Story.when("Clicked"),
 *     Story.when("Clicked"),
 *     Story.state("clicks", 2),
 *     Story.renders("Clicked 2 times"),
 *   ),
 * );
 * ```
 *
 * Every step is checked against the model `make` inferred, so a story can't
 * send an Intent the component doesn't declare or check state it doesn't have.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as Component from "./Component.ts";
import { isNode, type Child } from "./html.ts";
import type { LogEntry } from "./internal/instance.ts";
import { isSignal, sourceOf } from "./Signal.ts";

export class StoryFailed extends Data.TaggedError("StoryFailed")<{
  readonly step: string;
  readonly reason: string;
}> {
  override get message() {
    return `${this.step}: ${this.reason}`;
  }
}

interface ExternalCall {
  readonly service: string;
  readonly method: string;
  readonly args: ReadonlyArray<unknown>;
  readonly fiberId: number;
  readonly deferred: Deferred.Deferred<unknown, unknown>;
  checked: boolean;
  answered: boolean;
}

interface Externals {
  readonly calls: Array<ExternalCall>;
}

/** Collects the calls made to services provided with `Story.external`. */
export class StoryRuntime extends Context.Service<StoryRuntime, Externals>()(
  "@alchemy.run/ui/StoryRuntime",
) {}

/**
 * Provides `service` as a stand-in the story controls. Every method call waits
 * until the story answers it with `Story.succeed` or `Story.fail`.
 */
export const external = <I, S>(service: Context.Key<I, S>): Layer.Layer<I, never, StoryRuntime> =>
  Layer.effect(
    service,
    Effect.map(
      StoryRuntime,
      (runtime) =>
        new Proxy(
          {},
          {
            get: (_, method) =>
              typeof method !== "string"
                ? undefined
                : (...args: ReadonlyArray<unknown>) =>
                    Effect.withFiber((fiber) => {
                      const deferred = Deferred.makeUnsafe<unknown, unknown>();
                      runtime.calls.push({
                        service: service.key,
                        method,
                        args,
                        fiberId: fiber.id,
                        deferred,
                        checked: false,
                        answered: false,
                      });
                      return Deferred.await(deferred);
                    }),
          },
        ) as S,
    ),
  );

interface Context_ {
  readonly factory: Component.Factory<any>;
  readonly externals: Externals;
  mounted: Component.Mounted | undefined;
  /** Where the log stood when the last Intent was sent. */
  since: number;
}

declare const StepTypeId: unique symbol;

/** One step of a story, checked against the component's model `M`. */
export interface Step<in out M extends Component.Model> {
  readonly [StepTypeId]: (model: M) => M;
  readonly label: string;
  /** @internal */
  readonly run: (ctx: Context_) => Effect.Effect<void, StoryFailed, Scope.Scope>;
}

const step = <M extends Component.Model>(
  label: string,
  run: (ctx: Context_) => Effect.Effect<void, StoryFailed, Scope.Scope>,
): Step<M> => ({ label, run }) as Step<M>;

const failStep = (label: string, reason: string) =>
  Effect.fail(new StoryFailed({ step: label, reason }));

const show = (u: unknown): string => {
  try {
    return JSON.stringify(u) ?? String(u);
  } catch {
    return String(u);
  }
};

const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b) || Equal.equals(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  if (
    typeof a === "object" &&
    typeof b === "object" &&
    a !== null &&
    b !== null &&
    Object.getPrototypeOf(a) === Object.prototype &&
    Object.getPrototypeOf(b) === Object.prototype
  ) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
    );
  }
  return false;
};

const mountedOf = (ctx: Context_, label: string) =>
  ctx.mounted === undefined
    ? failStep(label, "the component isn't mounted yet. Start the story with Story.mount().")
    : Effect.succeed(ctx.mounted);

/**
 * Lets every running handler go as far as it can: until it finishes or waits
 * on a call to an external service the story hasn't answered.
 */
const settle = (ctx: Context_, label: string) =>
  Effect.gen(function* () {
    const { instance } = yield* mountedOf(ctx, label);
    const diedBefore = instance.log.filter((e) => e._tag === "Died").length;
    for (let i = 0; i < 1_000; i++) {
      const waiting = new Set(ctx.externals.calls.filter((c) => !c.answered).map((c) => c.fiberId));
      if ([...instance.running].every((fiber) => waiting.has(fiber.id))) {
        const died = instance.log.filter(
          (e): e is Extract<LogEntry, { _tag: "Died" }> => e._tag === "Died",
        );
        if (died.length > diedBefore) {
          const last = died[died.length - 1]!;
          return yield* failStep(label, `the ${last.intent} handler died: ${String(last.cause)}`);
        }
        return;
      }
      yield* Effect.yieldNow;
    }
    return yield* failStep(
      label,
      "a handler is still running. It's waiting on something the story doesn't control: a timer, or a service that wasn't provided with Story.external.",
    );
  });

/** Creates the component with `props`. Every story starts here. */
export const mount = <M extends Component.Model>(
  ...props: M["props"] extends void ? [] : [props: M["props"]]
): Step<M> =>
  step("mount", (ctx) =>
    Effect.gen(function* () {
      ctx.mounted = yield* ctx.factory.create(props[0]);
      yield* settle(ctx, "mount");
    }),
  );

/** Sends the Intent `name`, as the view would, and runs its handler as far as it can go. */
export const when = <M extends Component.Model, const K extends keyof M["intents"] & string>(
  name: K,
  ...payload: M["intents"][K] extends void ? [] : [payload: M["intents"][K]]
): Step<M> => {
  const label = `when ${name}`;
  return step(label, (ctx) =>
    Effect.gen(function* () {
      const { instance } = yield* mountedOf(ctx, label);
      if (!instance.intents.has(name)) {
        return yield* failStep(
          label,
          `${instance.component} didn't declare the Intent "${name}" in this mount.`,
        );
      }
      ctx.since = instance.log.length;
      instance.dispatch(name, payload[0]);
      yield* settle(ctx, label);
    }),
  );
};

/** Sets state directly, as history the story starts from. It isn't an Intent and isn't logged. */
export const given = <M extends Component.Model, const K extends keyof M["state"] & string>(
  name: K,
  value: M["state"][K],
): Step<M> => {
  const label = `given ${name}`;
  return step(label, (ctx) =>
    Effect.gen(function* () {
      const { instance } = yield* mountedOf(ctx, label);
      const node = instance.states.get(name);
      if (node === undefined)
        return yield* failStep(
          label,
          `${instance.component} has no state "${name}" in this mount.`,
        );
      node.write(value);
    }),
  );
};

/** Checks the current value of the state `name`. */
export const state = <M extends Component.Model, const K extends keyof M["state"] & string>(
  name: K,
  value: M["state"][K],
): Step<M> => {
  const label = `state ${name}`;
  return step(label, (ctx) =>
    Effect.gen(function* () {
      const { instance } = yield* mountedOf(ctx, label);
      const node = instance.states.get(name);
      if (node === undefined)
        return yield* failStep(
          label,
          `${instance.component} has no state "${name}" in this mount.`,
        );
      const actual = node.read();
      if (!same(actual, value)) {
        return yield* failStep(label, `expected ${show(value)}, got ${show(actual)}`);
      }
    }),
  );
};

/** Checks that the last Intent wrote `value` to the state `name` (its last write, if it wrote several). */
export const wrote = <M extends Component.Model, const K extends keyof M["state"] & string>(
  name: K,
  value: M["state"][K],
): Step<M> => {
  const label = `wrote ${name}`;
  return step(label, (ctx) =>
    Effect.gen(function* () {
      const { instance } = yield* mountedOf(ctx, label);
      const writes = instance.log
        .slice(ctx.since)
        .filter(
          (e): e is Extract<LogEntry, { _tag: "Write" }> => e._tag === "Write" && e.name === name,
        );
      const last = writes[writes.length - 1];
      if (last === undefined)
        return yield* failStep(label, `nothing wrote "${name}" since the last Intent`);
      if (!same(last.after, value)) {
        return yield* failStep(
          label,
          `expected a write of ${show(value)}, got ${show(last.after)}`,
        );
      }
    }),
  );
};

/** Checks that the rendered text contains `text`, computed from the view and current signal values. */
export const renders = <M extends Component.Model>(text: string): Step<M> => {
  const label = `renders ${show(text)}`;
  return step(label, (ctx) =>
    Effect.gen(function* () {
      const { view } = yield* mountedOf(ctx, label);
      const actual = textOf(view);
      if (!actual.includes(text)) return yield* failStep(label, `the view shows ${show(actual)}`);
    }),
  );
};

const textOf = (child: Child): string => {
  if (child === null || child === undefined || typeof child === "boolean") return "";
  if (typeof child === "string" || typeof child === "number") return String(child);
  if (Array.isArray(child)) return child.map(textOf).join("");
  if (isSignal(child)) return String(sourceOf(child).read());
  if (isNode(child)) return child.children.map(textOf).join("");
  return "";
};

type Method<S, K extends keyof S> = S[K] extends (
  ...args: infer A
) => Effect.Effect<infer Out, infer Err, any>
  ? { readonly args: A; readonly success: Out; readonly failure: Err }
  : never;

const callLabel = (service: Context.Key<any, any>, method: string) => `${service.key}.${method}`;

/** Checks the next unchecked call to `service.method` and its arguments. */
export const call = <I, S, const K extends keyof S & string>(
  service: Context.Key<I, S>,
  method: K,
  ...args: Method<S, K>["args"]
): Step<any> => {
  const label = `call ${callLabel(service, method)}`;
  return step(label, (ctx) =>
    Effect.gen(function* () {
      const next = ctx.externals.calls.find(
        (c) => c.service === service.key && c.method === method && !c.checked,
      );
      if (next === undefined) return yield* failStep(label, "no call was made");
      next.checked = true;
      if (!same(next.args, args)) {
        return yield* failStep(label, `expected arguments ${show(args)}, got ${show(next.args)}`);
      }
    }),
  );
};

const answer = (
  label: string,
  service: Context.Key<any, any>,
  method: string,
  complete: (deferred: Deferred.Deferred<unknown, unknown>) => Effect.Effect<boolean>,
) =>
  step(label, (ctx) =>
    Effect.gen(function* () {
      const next = ctx.externals.calls.find(
        (c) => c.service === service.key && c.method === method && !c.answered,
      );
      if (next === undefined) return yield* failStep(label, "there's no unanswered call to answer");
      next.answered = true;
      yield* complete(next.deferred);
      yield* settle(ctx, label);
    }),
  );

/** Answers the oldest unanswered call to `service.method` with `value`. */
export const succeed = <I, S, const K extends keyof S & string>(
  service: Context.Key<I, S>,
  method: K,
  value: Method<S, K>["success"],
): Step<any> =>
  answer(`succeed ${callLabel(service, method)}`, service, method, (d) =>
    Deferred.succeed(d, value),
  );

/** Fails the oldest unanswered call to `service.method` with `error`. */
export const fail = <I, S, const K extends keyof S & string>(
  service: Context.Key<I, S>,
  method: K,
  error: Method<S, K>["failure"],
): Step<any> =>
  answer(`fail ${callLabel(service, method)}`, service, method, (d) => Deferred.fail(d, error));

/**
 * Runs a story against a component and the Layer that implements it. The
 * Layer may leave only `StoryRuntime` unprovided, which `Story.external`
 * stand-ins need and the story supplies.
 */
export const story = <Self, ROut, RIn extends StoryRuntime = never>(
  target: {
    readonly component: Component.Key<Self, any>;
    readonly layer: Layer.Layer<ROut, never, RIn>;
  },
  ...steps: ReadonlyArray<Step<Component.ModelIn<ROut, Self>>>
): Effect.Effect<void, StoryFailed> =>
  Effect.scoped(
    Effect.gen(function* () {
      const externals: Externals = { calls: [] };
      const services = yield* Layer.build(
        target.layer.pipe(Layer.provide(Layer.succeed(StoryRuntime, externals))),
      );
      const ctx: Context_ = {
        factory: Context.get(services as unknown as Context.Context<Self>, target.component),
        externals,
        mounted: undefined,
        since: 0,
      };
      for (const s of steps) yield* s.run(ctx);
    }),
  ) as Effect.Effect<void, StoryFailed>;
