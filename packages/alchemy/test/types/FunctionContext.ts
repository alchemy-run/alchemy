import * as AWS from "@/AWS/index.ts";
import type * as Serverless from "@/Serverless/index.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

class InitDependency extends Context.Service<InitDependency, {}>()(
  "FunctionContext.InitDependency",
) {}

class InvocationDependency extends Context.Service<InvocationDependency, {}>()(
  "FunctionContext.InvocationDependency",
) {}

class CustomInitDependency extends Context.Service<CustomInitDependency, {}>()(
  "FunctionContext.CustomInitDependency",
) {}

class CustomInvocationDependency extends Context.Service<
  CustomInvocationDependency,
  {}
>()("FunctionContext.CustomInvocationDependency") {}

type Requirements<T> =
  T extends Effect.Effect<unknown, unknown, infer R> ? R : never;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

declare const defaultContext: Serverless.FunctionContext;

const defaultDeferred = defaultContext.listen(
  Effect.gen(function* () {
    yield* CustomInitDependency;
    return () =>
      Effect.gen(function* () {
        yield* CustomInvocationDependency;
      });
  }),
);

type _DefaultRequirements = Expect<
  Equal<
    Requirements<typeof defaultDeferred>,
    CustomInitDependency | CustomInvocationDependency
  >
>;

declare const context: Serverless.FunctionContext<
  Scope.Scope | InitDependency,
  Scope.Scope | InvocationDependency
>;

const direct = context.listen(() =>
  Effect.gen(function* () {
    yield* Scope.Scope;
    yield* InvocationDependency;
    yield* CustomInvocationDependency;
  }),
);

type _DirectRequirements = Expect<
  Equal<Requirements<typeof direct>, CustomInvocationDependency>
>;

const served = context.serve(
  Effect.gen(function* () {
    yield* Scope.Scope;
    yield* InvocationDependency;
    yield* CustomInvocationDependency;
    return HttpServerResponse.text("ok");
  }),
);

type _ServeRequirements = Expect<
  Equal<Requirements<typeof served>, CustomInvocationDependency>
>;

const deferred = context.listen(
  Effect.gen(function* () {
    yield* Scope.Scope;
    yield* InitDependency;
    yield* CustomInitDependency;
    return () =>
      Effect.gen(function* () {
        yield* Scope.Scope;
        yield* InvocationDependency;
        yield* CustomInvocationDependency;
      });
  }),
);

type _DeferredRequirements = Expect<
  Equal<
    Requirements<typeof deferred>,
    CustomInitDependency | CustomInvocationDependency
  >
>;

declare const lambdaContext: Serverless.FunctionContext<
  AWS.Lambda.FunctionInitServices,
  Scope.Scope | AWS.Lambda.HandlerContext
>;

const lambdaDeferred = lambdaContext.listen(
  Effect.gen(function* () {
    yield* Scope.Scope;
    return () =>
      Effect.gen(function* () {
        yield* Scope.Scope;
        yield* AWS.Lambda.HandlerContext;
        yield* CustomInvocationDependency;
      });
  }),
);

type _LambdaRequirements = Expect<
  Equal<Requirements<typeof lambdaDeferred>, CustomInvocationDependency>
>;

const yieldedLambdaFunction = Effect.gen(function* () {
  const context = yield* AWS.Lambda.Function;
  yield* context.listen(
    Effect.gen(function* () {
      yield* Layer.build(Layer.empty);
      yield* Scope.Scope;
      return () =>
        Effect.gen(function* () {
          yield* Scope.Scope;
          yield* AWS.Lambda.HandlerContext;
          yield* CustomInvocationDependency;
        });
    }),
  );
});

type YieldedLambdaRequirements = Requirements<typeof yieldedLambdaFunction>;
type _YieldedLambdaRequirements = Expect<
  Equal<
    YieldedLambdaRequirements,
    AWS.Lambda.Function | CustomInvocationDependency
  >
>;

class DeferredListenerFunction extends AWS.Lambda.Function<DeferredListenerFunction>()(
  "DeferredListenerFunctionTypeFixture",
  { main: import.meta.url },
  Effect.gen(function* () {
    yield* CustomInitDependency;
    const context = yield* AWS.Lambda.Function;
    yield* context.listen(
      Effect.gen(function* () {
        yield* Scope.Scope;
        return () =>
          Effect.gen(function* () {
            yield* Scope.Scope;
            yield* AWS.Lambda.HandlerContext;
          });
      }),
    );
  }),
) {}

type DeferredListenerFunctionRequirements = Requirements<
  typeof DeferredListenerFunction
>;
type _DeferredListenerFunctionRequirements = Expect<
  Equal<
    DeferredListenerFunctionRequirements,
    AWS.Providers | CustomInitDependency
  >
>;

class PropsDependency extends Context.Service<PropsDependency, {}>()(
  "FunctionContext.PropsDependency",
) {}

const props = Effect.gen(function* () {
  yield* PropsDependency;
  return { main: import.meta.url };
});

const implementation = Effect.gen(function* () {
  yield* CustomInitDependency;
  const host = yield* AWS.Lambda.Function;
  yield* host.listen(
    Effect.gen(function* () {
      yield* Scope.Scope;
      return () => Effect.asVoid(CustomInvocationDependency);
    }),
  );
});

type ApplicationRequirements =
  | PropsDependency
  | CustomInitDependency
  | CustomInvocationDependency;

const plain = AWS.Lambda.Function("PlainListener", props, implementation);
type _PlainRequirements = Expect<
  Equal<Requirements<typeof plain>, AWS.Providers | ApplicationRequirements>
>;

class Inline extends AWS.Lambda.Function<Inline>()(
  "InlineListener",
  props,
  implementation,
) {}
type _InlineRequirements = Expect<
  Equal<Requirements<typeof Inline>, AWS.Providers | ApplicationRequirements>
>;

class Split extends AWS.Lambda.Function<Split>()("SplitListener") {}
const split = Split.make(props, implementation);
type LayerRequirements<T extends Layer.Any> = Layer.Services<T>;
type _SplitRequirements = Expect<
  Equal<
    LayerRequirements<typeof split>,
    AWS.Providers | ApplicationRequirements
  >
>;

class Shaped extends AWS.Lambda.Function<Shaped, { label: string }>()(
  "ShapedListener",
) {}
const shaped = Shaped.make(
  props,
  Effect.as(implementation, { label: "listener" }),
);
type _ShapedRequirements = Expect<
  Equal<
    LayerRequirements<typeof shaped>,
    AWS.Providers | ApplicationRequirements
  >
>;

const wrongPhase = context.listen(
  Effect.gen(function* () {
    yield* InvocationDependency;
    return () => Effect.asVoid(InitDependency);
  }),
);
type _WrongPhaseRequirements = Expect<
  Equal<Requirements<typeof wrongPhase>, InvocationDependency | InitDependency>
>;

const initHandlerContext = lambdaContext.listen(
  Effect.gen(function* () {
    yield* AWS.Lambda.HandlerContext;
    return () => Effect.void;
  }),
);
type _InitHandlerContextRequirements = Expect<
  Equal<Requirements<typeof initHandlerContext>, AWS.Lambda.HandlerContext>
>;
