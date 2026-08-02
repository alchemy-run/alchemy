import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Input } from "./Input.ts";
import * as Output from "./Output.ts";
import type { ResourceLike } from "./Resource.ts";
import { Self } from "./Self.ts";
import { taggedFunction } from "./Util/effect.ts";

export interface ServiceLike {
  kind: "Service";
}

export interface ServiceShape<
  Identifier extends string,
  Shape extends (...args: any[]) => Effect.Effect<any, any, any>,
>
  extends Context.ServiceClass.Shape<Identifier, Shape>, ServiceLike {}

type BindParameters<
  Parameters extends any[],
  Req = never,
> = Parameters extends []
  ? []
  : // Variadic lists (`number extends length`) — e.g. `(...parameters:
    // [Parameter, ...Parameter[]])` — must be checked FIRST: a plain array
    // also matches the optional-head pattern below with itself as the rest,
    // which recurses forever (TS2589).
    number extends Parameters["length"]
    ? Parameters extends [infer First, ...infer Rest]
      ? [
          Input<First> | Effect.Effect<First, never, Req>,
          ...Array<
            Input<Rest[number]> | Effect.Effect<Rest[number], never, Req>
          >,
        ]
      : Array<
          | Input<Parameters[number]>
          | Effect.Effect<Parameters[number], never, Req>
        >
    : Parameters extends [infer First, ...infer Rest]
      ? [
          Input<First> | Effect.Effect<First, never, Req>,
          ...BindParameters<Rest, Req>,
        ]
      : // Optional head (e.g. `(bus?: EventBus)`) — `[infer F, ...R]` does
        // not match a tuple with an optional first element, which used to
        // collapse the whole parameter list to `[]` (`PutEvents(bus)` failed
        // with "Expected 0 arguments").
        Parameters extends [(infer First)?, ...infer Rest]
        ? [
            (Input<First> | Effect.Effect<First, never, Req>)?,
            ...BindParameters<Rest, Req>,
          ]
        : [];

/**
 * The combined tag + callable + type form of a binding (the `Resource.ts`-style
 * single-identifier pattern). `interface X extends Binding.Service<X, Id, Shape>`
 * declares the type; `const X = Binding.Service<X>(id)` produces a value that is at
 * once the Context tag (usable in `Layer.effect(X, …)` / `Effect.provide`), the
 * callable (`X(resource)`), and carries the type.
 */
export interface Service<
  Self,
  Identifier extends string,
  Shape extends (...args: any[]) => Effect.Effect<any, any, any>,
>
  extends Context.Service<Self, Shape>, ServiceLike {
  readonly key: Identifier;
  new (_: never): ServiceShape<Identifier, Shape>;
  <Req = never>(
    ...args: BindParameters<Parameters<Shape>, Req>
  ): Effect.Effect<
    Effect.Success<ReturnType<Shape>>,
    Effect.Error<ReturnType<Shape>>,
    Self | Effect.Services<ReturnType<Shape>> | Req
  >;
  /**
   * Invoke this capability at plan/deploy time as a **data source** — the
   * Terraform data-source / Pulumi invoke shape — and get an
   * {@link Output.Output} of the result.
   *
   * The returned Output is inert until the planner resolves it (with the
   * stack's services provided), so `execute` is safe to call from
   * composition code that is re-executed inside a deployed runtime bundle.
   * The capability's implementation layer must be registered on the stack
   * (cloud `providers()` layers include their plan-executable capabilities).
   *
   * Execution is hostless — {@link Host} resolves `undefined`, so
   * implementations skip their `host.bind` IAM/env wiring and only the read
   * runs. Failures die and fail the plan.
   *
   * Only capabilities whose runtime client is nullary (`() => Effect<A>`)
   * are executable; parameterized clients type as `never` here.
   */
  execute<Req = never>(
    ...args: BindParameters<Parameters<Shape>, Req>
  ): Effect.Success<ReturnType<Shape>> extends () => Effect.Effect<
    infer A,
    infer _E,
    infer R2
  >
    ? Output.ToOutput<A, Self | Effect.Services<ReturnType<Shape>> | R2 | Req>
    : never;
}

/**
 * Build a combined tag+callable binding (see {@link Service}). The returned
 * value forwards the Effect/Tag protocol to its Context tag (via `taggedFunction`)
 * so `Layer.effect`/`provide` work, while being directly callable to bind a
 * resource at the call site.
 */
export const Service = <
  Self extends ServiceLike & {
    readonly key: string;
  },
>(
  id: Self["key"],
): Self => {
  const tag = Context.Service<Self, (...args: any[]) => Effect.Effect<any>>(id);
  const callable = (...args: any[]) =>
    tag.use((f: (...a: any[]) => Effect.Effect<any>) =>
      Effect.all(
        args.map((arg) => (Effect.isEffect(arg) ? arg : Effect.succeed(arg))),
        { concurrency: "unbounded" },
      ).pipe(Effect.flatMap((resolved) => f(...resolved))),
    );
  // Plan-time invoke (see the `execute` doc on `Service`): bind hostless —
  // `Binding.Host` is total and resolves `undefined`, so impls skip their
  // `host.bind` wiring — run the nullary client, and lift the result into an
  // Output the planner resolves with the stack's services.
  (callable as any).execute = (...args: any[]) =>
    Output.fromEffect(
      callable(...args).pipe(
        Effect.flatMap((client: any) => client()),
        Effect.orDie,
      ) as Effect.Effect<any, never, any>,
    );
  return taggedFunction(tag as any, callable) as unknown as Self;
};

/**
 * Resolves the host resource a binding is attaching to (the Worker / Lambda
 * Function), i.e. `Self`. It is typed WITHOUT a Context requirement because it
 * is only ever read at DEPLOY time, inside the `if (!globalThis.__ALCHEMY_RUNTIME__)`
 * guard of a binding's impl layer — at runtime the host is absent and the guard
 * skips it, so leaking a `Self` requirement onto the runtime client would be
 * wrong.
 *
 * Total: resolves to `undefined` when no host is ambient — a plan-time
 * {@link Service.execute} invoke, or a binding client provided directly in a
 * script/test outside any Function. Narrow it with `isWorker`/`isFunction`/
 * `isBindingHost` before calling `host.bind`; the guards reject `undefined`.
 */
export const Host: Effect.Effect<ResourceLike | undefined> =
  Effect.serviceOption(
    Self as unknown as Context.Service<ResourceLike, ResourceLike>,
  ).pipe(Effect.map(Option.getOrUndefined));
