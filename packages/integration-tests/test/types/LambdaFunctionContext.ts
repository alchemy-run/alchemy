import * as AWS from "@alchemy.run/aws";
import type { FunctionContext } from "alchemy/Runtime/Function";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

class InitDependency extends Context.Service<InitDependency, {}>()(
  "FunctionContext.InitDependency",
) {}

class InvocationDependency extends Context.Service<InvocationDependency, {}>()(
  "FunctionContext.InvocationDependency",
) {}

class CustomInitDependency extends Context.Service<CustomInitDependency, {}>()(
  "FunctionContext.CustomInitDependency",
) {}

class CustomInvocationDependency extends Context.Service<CustomInvocationDependency, {}>()(
  "FunctionContext.CustomInvocationDependency",
) {}

type Requirements<T> = T extends Effect.Effect<unknown, unknown, infer R> ? R : never;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

declare const defaultContext: FunctionContext;

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
  Equal<Requirements<typeof defaultDeferred>, CustomInitDependency | CustomInvocationDependency>
>;

declare const context: FunctionContext<
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

type _DirectRequirements = Expect<Equal<Requirements<typeof direct>, CustomInvocationDependency>>;

const served = context.serve(
  Effect.gen(function* () {
    yield* Scope.Scope;
    yield* InvocationDependency;
    yield* CustomInvocationDependency;
    return HttpServerResponse.text("ok");
  }),
);

type _ServeRequirements = Expect<Equal<Requirements<typeof served>, CustomInvocationDependency>>;

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
  Equal<Requirements<typeof deferred>, CustomInitDependency | CustomInvocationDependency>
>;

declare const lambdaContext: FunctionContext<
  AWS.Lambda.FunctionInitServices,
  AWS.Lambda.FunctionInvocationServices
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
  Equal<YieldedLambdaRequirements, AWS.Lambda.Function | CustomInvocationDependency>
>;

// Services provided around `host.listen` satisfy the deferred initializer and
// the handler; `Scope` and `HandlerContext` are Lambda's to supply.
class DeferredListenerFunction extends AWS.Lambda.Function<DeferredListenerFunction>()(
  "DeferredListenerFunctionTypeFixture",
  { main: import.meta.url },
  Effect.gen(function* () {
    const context = yield* AWS.Lambda.Function;
    yield* context
      .listen(
        Effect.gen(function* () {
          yield* Scope.Scope;
          yield* CustomInitDependency;
          return () =>
            Effect.gen(function* () {
              yield* Scope.Scope;
              yield* AWS.Lambda.HandlerContext;
              yield* CustomInvocationDependency;
            });
        }),
      )
      .pipe(
        Effect.provideService(CustomInitDependency, {}),
        Effect.provideService(CustomInvocationDependency, {}),
      );
  }),
) {}

type _DeferredListenerFunctionRequirements = Expect<
  Equal<Requirements<typeof DeferredListenerFunction>, AWS.Providers>
>;

class UnprovidedListenerFunction extends AWS.Lambda.Function<UnprovidedListenerFunction>()(
  "UnprovidedListenerFunctionTypeFixture",
  { main: import.meta.url },
  // @ts-expect-error — an application service nobody provides is still a compile error
  Effect.gen(function* () {
    const context = yield* AWS.Lambda.Function;
    yield* context.listen(
      Effect.gen(function* () {
        yield* CustomInitDependency;
        return () => Effect.void;
      }),
    );
  }),
) {}

class PropsDependency extends Context.Service<PropsDependency, {}>()(
  "FunctionContext.PropsDependency",
) {}

const props = Effect.gen(function* () {
  yield* PropsDependency;
  return { main: import.meta.url };
});

const implementation = Effect.gen(function* () {
  const host = yield* AWS.Lambda.Function;
  yield* host
    .listen(
      Effect.gen(function* () {
        yield* Scope.Scope;
        yield* CustomInitDependency;
        return () => Effect.asVoid(CustomInvocationDependency);
      }),
    )
    .pipe(
      Effect.provideService(CustomInitDependency, {}),
      Effect.provideService(CustomInvocationDependency, {}),
    );
});

const plain = AWS.Lambda.Function("PlainListener", props, implementation);
type _PlainRequirements = Expect<
  Equal<Requirements<typeof plain>, AWS.Providers | PropsDependency>
>;

class Inline extends AWS.Lambda.Function<Inline>()("InlineListener", props, implementation) {}
type _InlineRequirements = Expect<
  Equal<Requirements<typeof Inline>, AWS.Providers | PropsDependency>
>;

class Split extends AWS.Lambda.Function<Split>()("SplitListener") {}
const split = Split.make(props, implementation);
type LayerRequirements<T extends Layer.Any> = Layer.Services<T>;
type _SplitRequirements = Expect<
  Equal<LayerRequirements<typeof split>, AWS.Providers | PropsDependency>
>;

class Shaped extends AWS.Lambda.Function<Shaped, { label: string }>()("ShapedListener") {}
const shaped = Shaped.make(props, Effect.as(implementation, { label: "listener" }));
type _ShapedRequirements = Expect<
  Equal<LayerRequirements<typeof shaped>, AWS.Providers | PropsDependency>
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
