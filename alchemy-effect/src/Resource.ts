import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { pipeArguments, type Pipeable } from "effect/Pipeable";
import { SingleShotGen } from "effect/Utils";
import { toFqn } from "./FQN.ts";
import { Self } from "./Host.ts";
import type { Input } from "./Input.ts";
import type { InstanceId } from "./InstanceId.ts";
import { CurrentNamespace, type NamespaceNode } from "./Namespace.ts";
import * as Output from "./Output.ts";
import { Provider, type ProviderService } from "./Provider.ts";
import { RemovalPolicy } from "./RemovalPolicy.ts";
import { Stack } from "./Stack.ts";

export type ResourceConstructor<R extends ResourceLike, Req = never> = {
  (
    id: string,
    ...args: {} extends R["Props"]
      ? [props?: Input<R["Props"]>]
      : [props: Input<R["Props"]>]
  ): Effect.Effect<R, never, Req>;
  <PropsReq = never>(
    id: string,
    props: Effect.Effect<Input<R["Props"]>, never, PropsReq>,
  ): Effect.Effect<R, never, PropsReq | Req>;
};

export type ResourceClass<Self extends ResourceLike> = ResourceConstructor<
  Self,
  Provider<Self>
> &
  Effect.Effect<ResourceConstructor<Self>> & {
    provider: ResourceProviders<Self>;
  };

export type LogicalId = string;

export interface ResourceBinding<Data = any> {
  namespace: NamespaceNode | undefined;
  sid: string;
  data: Data;
}

export interface ResourceLike<
  Type extends string = any,
  Props extends object | undefined = any,
  Attributes extends object = any,
  Binding = any,
> {
  /**
   * Namespace containing this Resource.
   */
  Namespace: NamespaceNode | undefined;
  /**
   * Fully Qualified Name (namespace path + logical ID).
   * Used as the unique key for state storage.
   */
  FQN: string;
  /**
   * Type of the Resource (e.g. AWS.Lambda.Function)
   */
  Type: Type;
  /**
   * Logical ID of the Resource (e.g. MyFunction)
   */
  LogicalId: LogicalId;
  /**
   * Properties of the Resource.
   */
  Props: Props;
  /**
   * Removal Policy of the Resource.
   */
  RemovalPolicy: RemovalPolicy["Service"];
  /** @internal phantom */
  Attributes: Attributes;
  /** @internal phantom */
  Binding: Binding;
}

export const isResource = (value: any): value is ResourceLike => {
  return typeof value === "object" && value !== null && "Type" in value;
};

export type Resource<
  Type extends string = any,
  Props extends object | undefined = any,
  Attributes extends object = any,
  Binding = never,
> = Pipeable &
  ResourceLike<Type, Props, Attributes, Binding> & {
    bind(sid: string, binding: Input<Binding>): Effect.Effect<void>;
    bind(
      template: TemplateStringsArray,
      ...args: any[]
    ): (binding: Input<Binding>) => Effect.Effect<void>;
  } & {
    [attr in keyof Attributes]-?: Output.Output<Attributes[attr], never>;
  };

export const Resource = <R extends ResourceLike>(
  type: R["Type"],
): ResourceClass<R> => {
  type Props = Input<R["Props"]>;
  const constructor = (
    id: string,
    props: Props | Effect.Effect<Props> | undefined,
  ) =>
    Effect.gen(function* () {
      const stack = yield* Stack;

      const existing = stack.resources[id];
      if (existing) {
        // TODO(sam): check if props are same and allow duplicates
        return yield* Effect.die(new Error(`Resource ${id} already exists`));
      }
      const bind = (
        ...args:
          | [sid: string, data: R["Binding"]]
          | [template: TemplateStringsArray, ...args: any[]]
      ) =>
        typeof args[0] === "string"
          ? Effect.gen(function* () {
              const [sid, data] = args as [sid: string, data: R["Binding"]];
              (stack.bindings[id] ??= []).push({
                namespace: yield* CurrentNamespace,
                sid,
                data,
              });
              return undefined;
            })
          : (data: R["Binding"]) =>
              bind(
                `${(args[0] as TemplateStringsArray)
                  .flatMap((text, i) => {
                    const arg = args[i + 1];
                    if (
                      arg &&
                      (typeof arg === "object" || typeof arg === "function")
                    ) {
                      if (
                        "LogicalId" in arg &&
                        typeof arg.LogicalId === "string"
                      ) {
                        return [text, arg.LogicalId];
                      } else if ("id" in arg && typeof arg.id === "string") {
                        return [text, arg.id];
                      }
                    }
                    return arg !== undefined ? [text, arg] : [text];
                  })
                  .join("")}`,
                data,
              );

      const namespace = yield* CurrentNamespace;
      const fqn = toFqn(namespace, id);

      const Resource: R = (stack.resources[id] = new Proxy(
        {
          Type: type,
          Namespace: namespace,
          FQN: fqn,
          LogicalId: id,
          Props: props,
          Provider: ProviderTag as Provider<any>,
          RemovalPolicy: yield* Effect.serviceOption(RemovalPolicy).pipe(
            Effect.map(Option.getOrElse(() => "destroy" as const)),
          ),

          bind,
        } as any,
        {
          get: (target, prop) =>
            typeof prop === "symbol" || prop in target
              ? target[prop as keyof typeof target]
              : new Output.PropExpr(Output.of(Resource), prop),
        },
      )) as R;
      Resource.Props = Effect.isEffect(props)
        ? yield* props.pipe(
            Effect.provideService(Self, Resource),
            // Effect.provideService(Namespace, {
            //   Id: id,
            //   Parent: namespace,
            // }),
          )
        : props;
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
