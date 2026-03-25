import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import type { Path } from "effect/Path";
import type { Scope } from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import type { Stdio } from "effect/Stdio";
import type { Terminal } from "effect/Terminal";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { SingleShotGen } from "effect/Utils";
import type { PolicyLike } from "../Binding.ts";
import { ExecutionContext } from "../ExecutionContext.ts";
import type { Input } from "../Input.ts";
import type { Provider } from "../Provider.ts";
import {
  Resource,
  type ResourceLike,
  type ResourceProviders,
} from "../Resource.ts";
import { Self } from "../Self.ts";
import type { Stack, StackServices } from "../Stack.ts";
import type { Stage } from "../Stage.ts";
import {
  ServerContext,
  type ServerExecutionContext,
} from "./ExecutionContext.ts";

/** Services available while defining the resource (stack / provider time). */
type ProcessServices =
  | Provider<any>
  | PolicyLike
  | Stack
  | Stage
  | Scope
  | StackServices;

/** Services installed by `make` around the implementation effect. */
type ProcessRuntimeServices =
  | ExecutionContext
  | ServerContext
  | HttpClient
  | ChildProcessSpawner
  | FileSystem
  | Path
  | Stdio
  | Terminal
  | Scope;

export type ProcessConstructor<
  Resource extends ResourceLike,
  ProvidedServices = never,
> = {
  Props: Resource["Props"];
  <SelfTag>(): <const Id extends string, Req = never>(
    id: Id,
    ...props: undefined extends Resource["Props"]
      ? [
          props?:
            | {
                [prop in keyof Resource["Props"]]: Input<
                  Resource["Props"][prop]
                >;
              }
            | Effect.Effect<
                {
                  [prop in keyof Resource["Props"]]: Input<
                    Resource["Props"][prop]
                  >;
                },
                never,
                Req
              >,
        ]
      : [
          props:
            | {
                [prop in keyof Resource["Props"]]: Input<
                  Resource["Props"][prop]
                >;
              }
            | Effect.Effect<
                {
                  [prop in keyof Resource["Props"]]: Input<
                    Resource["Props"][prop]
                  >;
                },
                never,
                Req
              >,
        ]
  ) => Effect.Effect<Resource, never, Provider<Resource> | SelfTag> & {
    new (_: never): {
      LogicalId: Id;
    };
    make<
      Req extends ProcessServices | ProvidedServices | SelfTag | Resource =
        never,
    >(
      impl: Effect.Effect<void, never, Req>,
    ): Layer.Layer<
      SelfTag,
      never,
      | Provider<Resource>
      | Exclude<
          Req,
          ProcessRuntimeServices | ProvidedServices | Resource | SelfTag
        >
    >;
  };

  asEffect(): Effect.Effect<Resource, never, Provider<Resource>>;

  [Symbol.iterator](): Effect.Yieldable<
    Effect.Effect<Resource, never, Provider<Resource>>,
    Resource,
    never,
    Provider<Resource>
  >;
};

export type ProcessClass<
  R extends ResourceLike,
  Runtime extends ServerExecutionContext,
  Services,
> = ProcessConstructor<R, Services> &
  Effect.Effect<ProcessConstructor<R, Services>> & {
    provider: ResourceProviders<R>;
    Self: ServiceMap.Service<R, R>;
    /** Host execution context for this process resource (e.g. `yield* Task.Runtime`). */
    Runtime: ServiceMap.Service<R, Runtime>;
  };

export const Process =
  <
    R extends ResourceLike<
      string,
      | {
          env?: Record<string, any>;
          exports?: string[];
        }
      | undefined
    >,
    Services = never,
  >(
    type: R["Type"],
  ) =>
  <Runtime extends ServerExecutionContext>(
    createExecutionContext: (id: string) => Runtime,
  ): ProcessClass<R, Runtime, Services | ProcessRuntimeServices> => {
    type PropsShape =
      | {
          [prop in keyof Exclude<R["Props"], undefined>]: Input<
            Exclude<R["Props"], undefined>[prop]
          >;
        }
      | undefined;
    type Props =
      | PropsShape
      | Effect.Effect<PropsShape, never, Services | Runtime>;
    type Impl = Effect.Effect<void, never, Services | Runtime>;

    const resource = Resource(type);
    const ctxTag = ExecutionContext<Runtime>(type);
    const self = Self<R>(type);
    const host = ServiceMap.Service<R, Runtime>(`Host<${type}>`);

    const constructor = () => (id: string, props: Props) => {
      const tag = ServiceMap.Service<Self, R>(`${type}<${id}>`);
      return class {
        static [Symbol.iterator](): Iterator<
          Effect.Yieldable<any, void, never, Self>,
          Resource,
          void
        > {
          return new SingleShotGen(this) as any;
        }
        static asEffect = () => tag.asEffect();
        static pipe(...args: any[]) {
          // @ts-expect-error
          return pipe(this.asEffect(), ...args);
        }
        static make = (impl: Impl) =>
          Layer.effect(
            tag,
            Effect.flatMap(
              Effect.all([
                Effect.isEffect(props)
                  ? props
                  : Effect.succeed(props ?? ({} as PropsShape)),
                Effect.sync(() => createExecutionContext(id)),
                Effect.services<never>(),
              ]),
              Effect.fnUntraced(function* ([
                props,
                executionContext,
                outerServices,
              ]) {
                const instance = yield* resource(id, props as any);

                yield* impl.pipe(
                  Effect.provide(
                    Layer.provideMerge(
                      Layer.mergeAll(
                        Layer.succeed(ctxTag, executionContext),
                        Layer.succeed(ExecutionContext, executionContext),
                        Layer.succeed(ServerContext, executionContext),
                        Layer.succeed(host, executionContext),
                        Layer.succeed(resource.Self, instance),
                        Layer.succeed(Self, instance),
                      ),
                      Layer.succeedServices(outerServices),
                    ),
                  ),
                );

                // @ts-expect-error deployed props + runtime env from execution context
                instance.Props = {
                  ...props,
                  env: {
                    ...props?.env,
                    ...executionContext.env,
                  },
                } as PropsShape;

                return Object.assign(instance, {
                  ExecutionContext: executionContext,
                }) as R;
              }),
            ),
          );
      };
    };

    return Object.assign(constructor, resource, {
      Runtime: host,
      Self: self,
    }) as any;
  };
