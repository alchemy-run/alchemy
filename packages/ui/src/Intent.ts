/**
 * Intents are the only way into a component. Each one has a name, an optional
 * payload, and a handler. The view attaches an Intent to a DOM event, and a
 * story sends the same Intent by name, so the browser and a test drive exactly
 * the same code.
 *
 * ```typescript
 * const clicked = yield* Intent.make("Clicked", clicks.update((n) => n + 1));
 * const typed = yield* Intent.make("Typed", Schema.String, (text) => name.set(text));
 *
 * html.button({ onClick: clicked }, "Click me");
 * html.input({ onInput: typed.from((e) => e.currentTarget.value) });
 * ```
 */
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import {
  type Declares,
  Handler,
  type Instance,
  type IntentDecl,
  Setup,
} from "./internal/instance.ts";

export const TypeId = "~@alchemy.run/ui/Intent";
export const TriggerTypeId = "~@alchemy.run/ui/Intent/Trigger";

export interface Intent<out N extends string, in out P> {
  readonly [TypeId]: { readonly _P: (payload: P) => P };
  readonly name: N;
  /** Sends this Intent with a fixed payload when the event fires. */
  readonly with: (payload: P) => Trigger<unknown>;
  /** Sends this Intent with a payload computed from the event. */
  readonly from: <Ev>(f: (event: Ev) => P) => Trigger<Ev>;
}

/** What a DOM event attribute accepts: an Intent with no payload, or a bound one. */
export interface Trigger<in Ev> {
  readonly [TriggerTypeId]: (event: Ev) => void;
  /** @internal */
  readonly fire: (event: Ev) => void;
}

const InstanceKey = "~@alchemy.run/ui/Intent/Instance";

/** @internal */
export const fire = (trigger: Trigger<any> | Intent<string, void>, event: unknown): void => {
  if (TriggerTypeId in trigger) trigger.fire(event);
  else
    (trigger as unknown as { [InstanceKey]: Instance })[InstanceKey].dispatch(
      trigger.name,
      undefined,
    );
};

export const isTrigger = (u: unknown): u is Trigger<unknown> | Intent<string, void> =>
  typeof u === "object" && u !== null && (TypeId in u || TriggerTypeId in u);

type Declared<N extends string, P, R> = Effect.Effect<
  Intent<N, P>,
  never,
  Setup | Declares<IntentDecl<N, P>> | Exclude<R, Handler>
>;

/**
 * Declares an Intent named `name`. The handler runs every time the Intent is
 * sent; it can wait, call services, and write state. It can't fail: put errors
 * in state, where the view can show them.
 */
export function make<const N extends string, R>(
  name: N,
  run: Effect.Effect<void, never, R>,
): Declared<N, void, R>;
export function make<const N extends string, P, R>(
  name: N,
  payload: Schema.Schema<P>,
  run: (payload: P) => Effect.Effect<void, never, R>,
): Declared<N, P, R>;
export function make(
  name: string,
  payloadOrRun: Schema.Top | Effect.Effect<void, never, any>,
  run?: (payload: any) => Effect.Effect<void, never, any>,
): Effect.Effect<Intent<string, any>, never, any> {
  const handler = run ?? ((_: unknown) => payloadOrRun as Effect.Effect<void, never, unknown>);
  return Effect.gen(function* () {
    const instance = yield* Setup;
    yield* instance.register(
      "intent",
      name,
      handler as (payload: unknown) => Effect.Effect<void, never, Handler>,
    );
    const bind = <Ev>(payload: (event: Ev) => unknown): Trigger<Ev> => {
      const send = (event: Ev) => instance.dispatch(name, payload(event));
      return { [TriggerTypeId]: send, fire: send };
    };
    const intent = {
      [TypeId]: { _P: (p: unknown) => p },
      [InstanceKey]: instance,
      name,
      with: (payload: unknown) => bind(() => payload),
      from: bind,
    };
    return intent as Intent<string, unknown>;
  });
}
