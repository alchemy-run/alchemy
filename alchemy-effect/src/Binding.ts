import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServiceMap from "effect/ServiceMap";
import { SingleShotGen } from "effect/Utils";

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
> extends ServiceMap.Service<Self, Shape> {
  readonly key: Identifier;
  new (_: never): PolicyShape<Identifier, Shape>;
  bind: (
    ...args: Parameters<Shape>
  ) => Effect.Effect<
    Effect.Success<ReturnType<Shape>>,
    Effect.Error<ReturnType<Shape>>,
    Self | Effect.Services<ReturnType<Shape>>
  >;
}

export const Policy =
  <Self, Shape extends (...args: any[]) => Effect.Effect<void, any, any>>() =>
  <Identifier extends string>(id: Identifier) => {
    const self = ServiceMap.Service<Self, Shape>(id) as Policy<
      Self,
      Identifier,
      Shape
    >;

    // we use a service option because at runtime (e.g. in a Lambda Function or Cloudflare Worker)
    // the Policy Layer is not provided and this becomes a no-op
    const Service = Effect.serviceOption(self)
      .asEffect()
      .pipe(
        Effect.map(Option.getOrElse(() => (() => Effect.void) as any as Shape)),
      );

    const policyTarget = (args: any[]) =>
      Layer.succeed(PolicyContext, {
        type: id,
        args,
      });
    return Object.assign(self, {
      [Symbol.iterator]() {
        return new SingleShotGen(this);
      },
      asEffect: () =>
        Service.pipe(
          Effect.map(
            (fn) =>
              (...args: any[]) =>
                fn(...args).pipe(Effect.provide(policyTarget(args))),
          ),
        ),
      bind: (...args: any[]) =>
        Service.pipe(
          Effect.flatMap((f) =>
            f(...args).pipe(Effect.provide(policyTarget(args))),
          ),
        ),
    });
  };

export class PolicyContext extends ServiceMap.Service<
  PolicyContext,
  {
    type: string;
    args: any[];
  }
>()("alchemy/Binding/Target") {}

export type Binding<Data = any> = {
  context: PolicyContext["Service"];
  data: Data;
};
