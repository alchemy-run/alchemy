import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Path } from "effect/Path";
import type { Scope } from "effect/Scope";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { DotAlchemy } from "./Config.ts";
import type { Input, InputProps } from "./Input.ts";
import * as Output from "./Output.ts";
import { ref } from "./Ref.ts";
import type { ResourceBinding, ResourceLike } from "./Resource.ts";
import { Stage } from "./Stage.ts";
import type { State } from "./State/State.ts";
import { taggedFunction } from "./Util/effect.ts";

export type StackServices =
  | Stack
  | Stage
  | Scope
  | FileSystem
  | Path
  | DotAlchemy
  | HttpClient
  | ChildProcessSpawner;

export type Stack = Context.ServiceClass.Shape<
  "Stack",
  Omit<StackSpec, "output">
>;

export const Stack: Context.ServiceClass<
  Stack,
  "Stack",
  Omit<StackSpec, "output">
> & {
  make<A, Req>(
    stack: {
      Shape: A;
    },
    effect: Effect.Effect<
      NoInfer<A extends object ? InputProps<A> : Input<A>>,
      never,
      Req
    >,
  ): Effect.Effect<CompiledStack<A>>;
  <Self>(): {
    <A, Req>(
      stackName: string,
      options: {
        providers: Layer.Layer<NoInfer<Req>, never, StackServices>;
        /**
         * Optional state backend layer. Falls back to `LocalState` when omitted.
         * May depend on any service the stack's `providers` or platform
         * provides (e.g. AWS `Credentials`, `Region`, `HttpClient`).
         */
        state?: Layer.Layer<State, any, NoInfer<Req> | StackServices>;
      },
      eff: Effect.Effect<A, never, Req>,
    ): Effect.Effect<Self> & {
      new (_: never): A extends object ? A : {};
      stage: {
        [stage: string]: Effect.Effect<Self>;
      };
    };
  };
  <Self, Shape>(): {
    Shape: Shape;
    (stackName: string): Effect.Effect<Self> & {
      new (_: never): Output.ToOutput<Shape>;
      make: <A, Req>(
        effect: Effect.Effect<A, never, Req>,
      ) => Effect.Effect<CompiledStack<A>>;
      stage: {
        [stage: string]: Effect.Effect<Self>;
      };
    };
  };
  <A, Req>(
    stackName: string,
    options: {
      providers: Layer.Layer<NoInfer<Req>, never, StackServices>;
      /**
       * Optional state backend layer. Falls back to `LocalState` when omitted.
       * May depend on any service the stack's `providers` or platform
       * provides (e.g. AWS `Credentials`, `Region`, `HttpClient`).
       */
      state?: Layer.Layer<State, any, NoInfer<Req> | StackServices>;
    },
    eff: Effect.Effect<A, never, Req | StackServices>,
  ): Effect.Effect<CompiledStack<A>>;
} = Object.assign(
  taggedFunction(
    Context.Service<Stack, Omit<StackSpec, "output">>()("Stack"),
    <A, Req>(
      stackName: string,
      options: {
        providers: Layer.Layer<NoInfer<Req>, never, StackServices>;
        state?: Layer.Layer<State, any, NoInfer<Req> | StackServices>;
      },
      eff: Effect.Effect<A, never, Req>,
    ) =>
      eff.pipe(
        make(stackName, options.providers, undefined, options.state),
        (eff) =>
          Object.assign(eff, {
            stage: new Proxy(
              {},
              {
                get: (_, stage: string) =>
                  ref({
                    stack: stackName,
                    stage,
                    id: stackName,
                  }),
              },
            ),
          }),
      ),
  ),
) as any;

export interface StackSpec<Output = any> {
  name: string;
  stage: string;
  // @internal
  resources: {
    [logicalId: string]: ResourceLike;
  };
  bindings: {
    [logicalId: string]: ResourceBinding[];
  };
  output: Output;
}

export interface CompiledStack<
  Output = any,
  Services = any,
> extends StackSpec<Output> {
  services: Context.Context<Services>;
  /**
   * Optional state backend layer supplied via `Stack(name, { state })`.
   * When omitted, the runtime (CLI / test harness) falls back to
   * `LocalState`. Its residual requirements are a subset of `Services`,
   * so it can be provided after `services` is applied.
   */
  state?: Layer.Layer<State, any, Services>;
}

export const StackName = Stack.use((stack) => Effect.succeed(stack.name));

export const make =
  <ROut = never>(
    name: string,
    providers: Layer.Layer<ROut, never, StackServices>,
    /** @internal */
    stack?: StackSpec,
    state?: Layer.Layer<State, any, ROut | StackServices>,
  ) =>
  <A, Err = never, Req extends ROut | StackServices = never>(
    effect: Effect.Effect<A, Err, Req>,
  ) =>
    Effect.all([
      effect,
      Stack.asEffect(),
      Effect.context<ROut | StackServices>(),
    ]).pipe(
      Effect.map(
        ([output, stack, services]) =>
          ({
            ...stack,
            output,
            services,
            state,
          }) satisfies CompiledStack<A, ROut | StackServices> as CompiledStack<
            A,
            ROut | StackServices
          >,
      ),
      Effect.provide(providers),
      Effect.provideServiceEffect(
        Stack,
        Stage.asEffect().pipe(
          Effect.map(
            (stage) =>
              (stack ?? {
                name,
                stage,
                resources: {},
                bindings: {},
              }) satisfies Stack["Service"],
          ),
          Effect.tap(Effect.logInfo),
        ),
      ),
    );

export const CurrentStack = Effect.serviceOption(Stack)
  .asEffect()
  .pipe(Effect.map(Option.getOrUndefined));
