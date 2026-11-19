import * as AWS from "@alchemy.run/aws";
import { Stage } from "alchemy/Stage";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

class ApplicationConfig extends Context.Service<ApplicationConfig, string>()(
  "ListenerProbe.ApplicationConfig",
) {}

class DeferredInitDuringDeploy extends Data.TaggedError("DeferredInitDuringDeploy") {}

class ExpectedListenerFailure extends Data.TaggedError("ExpectedListenerFailure") {}

class RequestValue extends Context.Service<RequestValue, number>()("ListenerProbe.RequestValue") {}

export default class ListenerProbe extends AWS.Lambda.Function<ListenerProbe>()(
  "ListenerProbe",
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const host = yield* AWS.Lambda.Function;
    const state = yield* Effect.sync(() => ({
      sandbox: crypto.randomUUID(),
      initialized: 0,
      finalized: 0,
      instanceFinalized: false,
      requests: 0,
      requestBuilds: 0,
      previousScope: undefined as Scope.Scope | undefined,
    }));
    const requestValue = Layer.effect(
      RequestValue,
      Effect.sync(() => ++state.requestBuilds),
    );
    const report = (init?: {
      scope: Scope.Scope;
      config: string | undefined;
      stage: string | undefined;
      accountId: string | undefined;
      region: string | undefined;
      hasHandlerContext: boolean;
    }) =>
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const context = yield* AWS.Lambda.HandlerContext;
        const config = yield* Effect.serviceOption(ApplicationConfig);
        const requestBuild = yield* RequestValue;
        const snapshot = yield* Effect.sync(() => {
          const freshScope = scope !== state.previousScope;
          state.previousScope = scope;
          return { ...state, request: ++state.requests, freshScope };
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            state.finalized++;
          }),
        );
        return yield* HttpServerResponse.json({
          sandbox: snapshot.sandbox,
          initialized: snapshot.initialized,
          finalized: snapshot.finalized,
          instanceFinalized: snapshot.instanceFinalized,
          request: snapshot.request,
          requestBuild,
          freshScope: snapshot.freshScope,
          distinctInitScope: init === undefined || init.scope !== scope,
          requestId: context.awsRequestId,
          config: Option.getOrUndefined(config),
          initConfig: init?.config,
          stage: init?.stage,
          accountId: init?.accountId,
          region: init?.region,
          initHasHandlerContext: init?.hasHandlerContext,
        });
      }).pipe(Effect.provide(requestValue), Effect.orDie);

    yield* host
      .listen(
        Effect.gen(function* () {
          if (!globalThis.__ALCHEMY_RUNTIME__) {
            return yield* Effect.die(new DeferredInitDuringDeploy());
          }
          yield* Effect.sync(() => {
            state.initialized++;
          });
          const scope = yield* Effect.scope;
          const config = yield* Effect.serviceOption(ApplicationConfig);
          const stage = yield* Effect.serviceOption(Stage);
          const environment = yield* Effect.serviceOption(AWS.AWSEnvironment);
          const aws = Option.isSome(environment) ? yield* environment.value : undefined;
          const handlerContext = yield* Effect.serviceOption(AWS.Lambda.HandlerContext);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              state.instanceFinalized = true;
            }),
          );
          const handler = AWS.Lambda.makeFunctionHttpHandler(
            report({
              scope,
              config: Option.getOrUndefined(config),
              stage: Option.getOrUndefined(stage),
              accountId: aws?.accountId,
              region: aws?.region,
              hasHandlerContext: Option.isSome(handlerContext),
            }),
          );
          return (event: any) => (event.rawPath === "/deferred" ? handler(event) : undefined);
        }),
      )
      .pipe(Effect.provideService(ApplicationConfig, "deferred"));

    const direct = AWS.Lambda.makeFunctionHttpHandler(report());
    yield* host
      .listen((event: any) => {
        if (event.rawPath === "/direct") return direct(event);
        if (event.rawPath === "/fail") {
          return report().pipe(Effect.andThen(Effect.die(new ExpectedListenerFailure())));
        }
      })
      .pipe(Effect.provideService(ApplicationConfig, "direct"));

    yield* host.serve(report()).pipe(Effect.provide(Layer.succeed(ApplicationConfig, "serve")));
  }),
) {}
