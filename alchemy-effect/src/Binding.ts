import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServiceMap from "effect/ServiceMap";
import { SingleShotGen } from "effect/Utils";
import { ExecutionContext } from "./Host.ts";
import { namespace } from "./Namespace.ts";

export interface ServiceLike {
  kind: "Service";
}

export interface ServiceShape<
  Identifier extends string,
  Shape extends (...args: any[]) => Effect.Effect<any, any, any>,
>
  extends ServiceMap.ServiceClass.Shape<Identifier, Shape>, ServiceLike {}

export interface Service<
  Self,
  Identifier extends string,
  Shape extends (...args: any[]) => Effect.Effect<any, any, any>,
>
  extends ServiceMap.Service<Self, Shape>, ServiceLike {
  readonly key: Identifier;
  new (_: never): ServiceShape<Identifier, Shape>;
  bind: (
    ...args: Parameters<Shape>
  ) => Effect.Effect<
    Effect.Success<ReturnType<Shape>>,
    Effect.Error<ReturnType<Shape>>,
    Self | Effect.Services<ReturnType<Shape>>
  >;
}

export const Service =
  <Self, Shape extends (...args: any[]) => Effect.Effect<any, any, any>>() =>
  <Identifier extends string>(id: Identifier) => {
    const self = ServiceMap.Service<Self, Shape>(id) as Service<
      Self,
      Identifier,
      Shape
    >;
    return Object.assign(self, {
      bind: (...args: any[]) => self.use((f) => f(...args)),
    });
  };

export interface PolicyLike {
  kind: "Policy";
}

export interface PolicyShape<
  Identifier extends string,
  Shape extends (...args: any[]) => Effect.Effect<any, any, any>,
>
  extends ServiceMap.ServiceClass.Shape<Identifier, Shape>, PolicyLike {}

export interface Policy<
  in out Self,
  in out Identifier extends string,
  in out Shape extends (...args: any[]) => Effect.Effect<any, any, any>,
> extends Effect.Effect<Shape, never, Self | ExecutionContext> {
  readonly key: Identifier;
  new (_: never): PolicyShape<Identifier, Shape>;
  layer: {
    succeed(
      fn: (
        ctx: ExecutionContext["Service"],
        ...args: Parameters<Shape>
      ) => Effect.Effect<void>,
    ): Layer.Layer<Self>;
    effect<Req = never>(
      fn: Effect.Effect<
        (
          ctx: ExecutionContext["Service"],
          ...args: Parameters<Shape>
        ) => Effect.Effect<void>,
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
    Self | ExecutionContext | Effect.Services<ReturnType<Shape>>
  >;
}

export const Policy =
  <Self, Shape extends (...args: any[]) => Effect.Effect<void, any, any>>() =>
  <Identifier extends string>(
    Identifier: Identifier,
  ): Policy<Self, `Policy<${Identifier}>`, Shape> => {
    const self = ServiceMap.Service<Self, Shape>(`Policy<${Identifier}>`);

    // we use a service option because at runtime (e.g. in a Lambda Function or Cloudflare Worker)
    // the Policy Layer is not provided and this becomes a no-op
    const Service = Effect.serviceOption(self)
      .asEffect()
      .pipe(
        Effect.map(Option.getOrElse(() => (() => Effect.void) as any as Shape)),
      );

    const asEffect = () =>
      Effect.all([ExecutionContext.asEffect(), Service]).pipe(
        Effect.map(
          ([ctx, fn]) =>
            (...args: any[]) =>
              fn(ctx, ...args).pipe(
                namespace(
                  `${Identifier}(${args
                    .flatMap((arg) =>
                      typeof arg === "object" && "LogicalId" in arg
                        ? [arg.LogicalId]
                        : ["string", "number", "boolean"].includes(typeof arg)
                          ? [arg]
                          : // TODO(sam): improve SID generation to support arrays and objects
                            [],
                    )
                    .join(", ")})`,
                ),
              ),
        ),
      );
    // @ts-expect-error
    return Object.assign(self, {
      [Symbol.iterator]() {
        return new SingleShotGen(this);
      },
      asEffect,
      bind: (...args: any[]) =>
        asEffect().pipe(Effect.flatMap((fn) => fn(...args))),
      layer: {
        succeed: (
          fn: (
            ctx: ExecutionContext["Service"],
            ...args: Parameters<Shape>
          ) => Effect.Effect<void>,
        ) =>
          Layer.succeed(
            self,
            // @ts-expect-error
            (...args: Parameters<Shape>) =>
              ExecutionContext.asEffect().pipe(
                Effect.flatMap((ctx) => fn(ctx, ...args)),
              ),
          ),
        effect: (
          fn: Effect.Effect<
            (
              ctx: ExecutionContext["Service"],
              ...args: Parameters<Shape>
            ) => Effect.Effect<void>
          >,
        ) =>
          Layer.effect(
            self,
            // @ts-expect-error
            fn.pipe(
              Effect.map(
                (fn) =>
                  (...args: Parameters<Shape>) =>
                    ExecutionContext.asEffect().pipe(
                      Effect.map((ctx) => fn(ctx, ...args)),
                    ),
              ),
            ),
          ),
      },
    });
  };
