import { ConfigProvider } from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { AlchemyContext, AlchemyContextLive } from "./AlchemyContext.ts";
import { provideFreshArtifactStore } from "./Artifacts.ts";
import { AuthProviders } from "./Auth/AuthProvider.ts";
import { CredentialsStoreLive } from "./Auth/Credentials.ts";
import { ProfileStoreLive } from "./Auth/Profile.ts";
import { type CompiledStack, type StackEffect, StateScope } from "./Stack.ts";
import { Stage } from "./Stage.ts";
import { loadConfigProvider } from "./Util/ConfigProvider.ts";
import { fileLogger } from "./Util/FileLogger.ts";
import { PlatformServices } from "./Util/PlatformServices.ts";

// Deploy-time only: kept out of `Stack.ts` because every runtime imports the
// `Stack` tag, and this module's top-level platform layer (Node + Bun
// platforms, `ws`, profile and credential stores) survives tree-shaking.

const platform = Layer.mergeAll(
  PlatformServices,
  FetchHttpClient.layer,
  Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
  Layer.provide(ProfileStoreLive, PlatformServices),
  Layer.provide(CredentialsStoreLive, PlatformServices),
);
// override alchemy state store, CLI/reporting, state, and Config
const alchemy = (overrides?: { dev?: boolean }) =>
  Layer.mergeAll(
    // optional
    overrides?.dev
      ? Layer.provide(
          Layer.effect(
            AlchemyContext,
            AlchemyContext.useSync((ctx) => ({ ...ctx, dev: overrides.dev! })),
          ),
          AlchemyContextLive,
        )
      : AlchemyContextLive,
  );

export const evalStack = <A, B, StackErr, Err, Req>(
  effect: StackEffect<CompiledStack<A>, StackErr, Stage | AlchemyContext>,
  fn: (stack: CompiledStack<A>) => Effect.Effect<B, Err, Req>,
  options: {
    stage: string;
    dev?: boolean;
    /**
     * Optional caller-supplied scope. When provided, scoped resources
     * (e.g. the dev sidecar process) live until the caller closes this
     * scope instead of being torn down when `evalStack` resolves. Used
     * by the test harness so the sidecar survives across `beforeAll`,
     * tests, and `afterAll`. When omitted, behaves as before with a
     * private scope closed on completion. The state store never outlives
     * the call.
     */
    scope?: Scope.Scope;
  },
) => {
  const body = Effect.gen(function* () {
    const stack = yield* effect;
    const configProvider = yield* loadConfigProvider(Option.none());
    return yield* fn(stack).pipe(
      provideFreshArtifactStore,
      Effect.provide(
        Layer.succeedContext(stack.services).pipe(
          Layer.provideMerge(Layer.succeed(ConfigProvider, configProvider)),
        ),
      ),
    );
  }).pipe(
    Effect.provide(
      Layer.effect(
        AuthProviders,
        Effect.serviceOption(AuthProviders).pipe(Effect.map(Option.getOrElse(() => ({})))),
      ).pipe(
        Layer.provideMerge(Layer.succeed(Stage, options.stage)),
        Layer.provideMerge(Layer.provideMerge(alchemy({ dev: options.dev }), platform)),
      ),
    ),
  );

  const scope = options.scope;
  return scope === undefined
    ? Effect.scoped(body)
    : // The state store closes with this call and releases its lease, so
      // the next call on the same long-lived scope can take it.
      Effect.scopedWith((stateScope) =>
        Scope.provide(body.pipe(Effect.provideService(StateScope, stateScope)), scope),
      );
};
