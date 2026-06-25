import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Input } from "./Input.ts";
import * as Namespace from "./Namespace.ts";
import { ALCHEMY_PHASE } from "./Phase.ts";
import { tryFindProviderByType } from "./Provider.ts";
import type { ResourceLike } from "./Resource.ts";
import { RuntimeContext } from "./RuntimeContext.ts";
import { Self } from "./Self.ts";
import { CurrentStack } from "./Stack.ts";
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
> = Parameters extends [infer First, ...infer Rest]
  ? [
      Input<First> | Effect.Effect<First, never, Req>,
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
  return taggedFunction(tag as any, callable) as unknown as Self;
};

/**
 * Resolves the host resource a binding is attaching to (the Worker / Lambda
 * Function), i.e. `Self`. It is typed WITHOUT a Context requirement because it
 * is only ever read at DEPLOY time, inside the `if (!globalThis.__ALCHEMY_RUNTIME__)`
 * guard of a binding's impl layer — at runtime the host is absent and the guard
 * skips it, so leaking a `Self` requirement onto the runtime client would be
 * wrong. Narrow it with `isWorker`/`isFunction` before calling `host.bind`.
 */
export const Host = Self as unknown as Effect.Effect<ResourceLike>;

export interface PolicyLike {
  kind: "Policy";
}

export interface PolicyShape<
  Identifier extends string,
  Shape extends (...args: any[]) => Effect.Effect<any, any, any>,
>
  extends Context.ServiceClass.Shape<Identifier, Shape>, PolicyLike {}

export interface Policy<
  in out Self,
  in out Identifier extends string,
  in out Shape extends (...args: any[]) => Effect.Effect<any, any, any>,
> extends Effect.Effect<Shape, never, Self> {
  readonly key: Identifier;
  new (_: never): PolicyShape<Identifier, Shape>;
  layer: {
    succeed(
      fn: (ctx: ResourceLike, ...args: Parameters<Shape>) => ReturnType<Shape>,
    ): Layer.Layer<Self>;
    effect<Req = never>(
      fn: Effect.Effect<
        (ctx: ResourceLike, ...args: Parameters<Shape>) => ReturnType<Shape>,
        never,
        Req
      >,
    ): Layer.Layer<Self, never, Req>;
  };
  bind(
    ...args: Parameters<Shape>
  ): Effect.Effect<
    Effect.Success<ReturnType<Shape>>,
    Effect.Error<ReturnType<Shape>>,
    Self | RuntimeContext | Effect.Services<ReturnType<Shape>>
  >;
}

/**
 * Creates a deploy-time binding policy.
 *
 * A `Binding.Policy` attaches the infrastructure-side permissions or bindings
 * that make a runtime binding usable. At deploy time it records IAM statements
 * or host bindings on the target function/worker. At runtime the layer is
 * absent, so the policy gracefully becomes a no-op.
 */
export const Policy =
  <
    Self,
    Shape extends (...args: any[]) => Effect.Effect<void, any, any>,
    Provider = Self,
  >() =>
  <Identifier extends string>(
    Identifier: Identifier,
  ): Policy<Provider, `Policy<${Identifier}>`, Shape> => {
    const self = Context.Service<Self, Shape>(`Policy<${Identifier}>`);

    // we use a service option because at runtime (e.g. in a Lambda Function or Cloudflare Worker)
    // the Policy Layer is not provided and this becomes a no-op
    const Service = tryFindProviderByType<Policy<Self, Identifier, Shape>>(
      self.key as Identifier,
    ).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.flatMap((service) =>
        service
          ? Effect.succeed(service)
          : Effect.all([CurrentStack, ALCHEMY_PHASE]).pipe(
              Effect.flatMap(([stack, phase]) =>
                stack && phase === "plan"
                  ? Effect.die(
                      `Binding.Policy provider 'Policy<${Identifier}>' was not provided at Plan Time in Stack '${stack.name}'`,
                    )
                  : Effect.succeed((() => Effect.void) as any as Shape),
              ),
            ),
      ),
    );

    const evaluate = () =>
      Effect.all([Self, Service]).pipe(
        Effect.map(
          ([resource, fn]) =>
            (...args: any[]) =>
              Effect.all(
                args.map((arg) =>
                  Effect.isEffect(arg) ? arg : Effect.succeed(arg),
                ),
              ).pipe(
                Effect.flatMap((args) =>
                  fn(...args).pipe(
                    Namespace.push((resource as ResourceLike).LogicalId),
                  ),
                ),
              ),
        ),
      );
    // @ts-expect-error
    return Object.assign(
      self,
      // `self` is a Context tag (already an Effect). Spreading the Effect
      // prototype retargets `yield* Policy` from the raw tag to the resolved
      // bind-function while keeping `Effect.isEffect(Policy)` true so
      // `Effect.all`/`forEach` behave.
      Effectable.Prototype({
        label: `Policy<${Identifier}>`,
        evaluate,
      }),
      {
        bind: (...args: any[]) =>
          evaluate().pipe(Effect.flatMap((fn) => fn(...args))),
        layer: {
          succeed: (
            fn: (
              self: ResourceLike,
              ...args: Parameters<Shape>
            ) => Effect.Effect<void>,
          ) =>
            Layer.succeed(
              self,
              // @ts-expect-error
              (...args: Parameters<Shape>) =>
                Self.use((self) => fn(self as ResourceLike, ...args)),
            ),
          effect: (
            fn: Effect.Effect<
              (
                self: ResourceLike,
                ...args: Parameters<Shape>
              ) => Effect.Effect<void>
            >,
          ) =>
            Layer.effect(
              self,
              // @ts-expect-error
              Effect.map(
                fn,
                (fn) =>
                  (...args: Parameters<Shape>) =>
                    Self.use((self) => fn(self as ResourceLike, ...args)),
              ),
            ),
        },
      },
    );
  };
