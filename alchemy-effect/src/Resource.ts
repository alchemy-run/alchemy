import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { pipeArguments, type Pipeable } from "effect/Pipeable";
import { SingleShotGen } from "effect/Utils";
import { PolicyContext } from "./Binding.ts";
import type { Input } from "./Input.ts";
import type { InstanceId } from "./InstanceId.ts";
import * as Output from "./Output.ts";
import { Provider, type ProviderService } from "./Provider.ts";
import { RemovalPolicy } from "./RemovalPolicy.ts";
import { Stack } from "./Stack.ts";

export type ResourceConstructor<R extends ResourceLike, Req = never> = (
  id: string,
  props?: Input<R["Props"]>,
) => Effect.Effect<R, never, Req>;

export type ResourceClass<Self extends ResourceLike> = ResourceConstructor<
  Self,
  Provider<Self>
> &
  Effect.Effect<ResourceConstructor<Self>> & {
    provider: ResourceProviders<Self>;
  };

export type LogicalId = string;

export interface ResourceLike<
  Type extends string = any,
  Props extends object = any,
  Attributes extends object = any,
  Binding = any,
> {
  Type: Type;
  LogicalId: LogicalId;
  Props: Props;
  /** @internal phantom */
  Attributes: Attributes;
  /** @internal phantom */
  Binding: Binding;
  Provider: Provider<this>;
  RemovalPolicy: RemovalPolicy["Service"];
}

export const isResource = (value: any): value is ResourceLike => {
  return typeof value === "object" && value !== null && "Type" in value;
};

export type Resource<
  Type extends string = any,
  Props extends object = any,
  Attributes extends object = any,
  Binding = never,
> = Pipeable &
  ResourceLike<Type, Props, Attributes, Binding> & {
    bind(binding: Input<Binding>): Effect.Effect<void>;
  } & {
    [attr in keyof Attributes]-?: Output.Output<Attributes[attr], never>;
  };

export const Resource = <R extends ResourceLike>(
  type: R["Type"],
): ResourceClass<R> => {
  const constructor = Effect.fnUntraced(function* (
    id: string,
    props?: R["Props"],
  ) {
    const stack = yield* Stack;

    const existing = stack.resources[id];
    if (existing) {
      // TODO(sam): check if props are same and allow duplicates
      return yield* Effect.die(new Error(`Resource ${id} already exists`));
    }

    const Resource: R = (stack.resources[id] = new Proxy(
      {
        Type: type,
        LogicalId: id,
        Props: props,
        Provider: ProviderTag,
        RemovalPolicy: yield* Effect.serviceOption(RemovalPolicy).pipe(
          Effect.map(Option.getOrElse(() => "destroy" as const)),
        ),
        // Attributes: undefined!,
        // Binding: undefined!,
        bind: Effect.fn(function* (data: any) {
          const target = yield* PolicyContext;
          (stack.bindings[id] ??= []).push({
            data,
            target,
          });
        }),
      } as any,
      {
        get: (target, prop) =>
          typeof prop === "symbol" || prop in target
            ? target[prop as keyof typeof target]
            : new Output.PropExpr(Output.of(Resource), prop),
      },
    )) as R;
    return Resource;
  });

  const ProviderTag = Provider(type);

  const Service = {
    [Symbol.iterator]() {
      return new SingleShotGen(this);
    },
    pipe() {
      return pipeArguments(this.asEffect(), arguments);
    },
    asEffect() {
      return Effect.map(
        Effect.services(),
        (services) => (id: string, props: R["Props"]) =>
          constructor(id, props).pipe(Effect.provide(services)),
      );
    },
    provider: {
      tag: ProviderTag,
      of: ProviderTag.of,
      effect: Layer.effect(ProviderTag),
      succeed: Layer.succeed(ProviderTag),
    },
  };

  return Object.assign(constructor, Service) as any as ResourceClass<R>;
};

export interface ResourceProviders<Resource extends ResourceLike> {
  effect<
    Req = never,
    ReadReq = never,
    DiffReq = never,
    PrecreateReq = never,
    CreateReq = never,
    UpdateReq = never,
    DeleteReq = never,
  >(
    eff: Effect.Effect<
      ProviderService<
        Resource,
        ReadReq,
        DiffReq,
        PrecreateReq,
        CreateReq,
        UpdateReq,
        DeleteReq
      >,
      never,
      Req
    >,
  ): Layer.Layer<
    Provider<Resource>,
    never,
    Exclude<
      | Req
      | ReadReq
      | DiffReq
      | PrecreateReq
      | CreateReq
      | UpdateReq
      | DeleteReq,
      InstanceId
    >
  >;
  succeed: <
    ReadReq = never,
    DiffReq = never,
    PrecreateReq = never,
    CreateReq = never,
    UpdateReq = never,
    DeleteReq = never,
  >(
    service: ProviderService<
      Resource,
      ReadReq,
      DiffReq,
      PrecreateReq,
      CreateReq,
      UpdateReq,
      DeleteReq
    >,
  ) => Layer.Layer<
    Provider<Resource>,
    never,
    Exclude<
      ReadReq | DiffReq | PrecreateReq | CreateReq | UpdateReq | DeleteReq,
      InstanceId
    >
  >;

  of: <
    ReadReq = never,
    DiffReq = never,
    PrecreateReq = never,
    CreateReq = never,
    UpdateReq = never,
    DeleteReq = never,
  >(
    service: ProviderService<
      Resource,
      ReadReq,
      DiffReq,
      PrecreateReq,
      CreateReq,
      UpdateReq,
      DeleteReq
    >,
  ) => ProviderService<
    Resource,
    ReadReq,
    DiffReq,
    PrecreateReq,
    CreateReq,
    UpdateReq,
    DeleteReq
  >;
}
