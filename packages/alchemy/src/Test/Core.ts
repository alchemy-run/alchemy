import { ConfigProvider } from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { AdoptPolicy } from "../AdoptPolicy.ts";
import { AlchemyContext, AlchemyContextLive } from "../AlchemyContext.ts";
import { apply } from "../Apply.ts";
import { provideFreshArtifactStore } from "../Artifacts.ts";
import { AuthProviders } from "../Auth/AuthProvider.ts";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive, withProfileOverride } from "../Auth/Profile.ts";
import { LoggingCli } from "../Cli/LoggingCli.ts";
import { destroy as _destroy } from "../Destroy.ts";
import type { Input } from "../Input.ts";
import * as Plan from "../Plan.ts";
import {
  type CompiledStack,
  evalStack,
  make as makeStack,
  Stack,
  type StackEffect,
  type StackServices,
} from "../Stack.ts";
import { Stage } from "../Stage.ts";
import * as State from "../State/index.ts";
import { tail } from "../Tail.ts";
import { TelemetryLive } from "../Telemetry/Layer.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";
import { PlatformServices } from "../Util/PlatformServices.ts";

/**
 * Configuration shared by every test in a file. Pass to `Test.make(...)`.
 */
export interface MakeOptions<ROut = any> {
  /** Provider layer for the stack — e.g. `AWS.providers()`, `Cloudflare.providers()`. */
  providers: Layer.Layer<ROut, never, StackServices>;
  /** State store for top-level `deploy(Stack)` / `destroy(Stack)`; defaults to {@link State.localState}. */
  state?: Layer.Layer<State.State, never, StackServices>;
  /** Override `ALCHEMY_PROFILE`; otherwise resolved from env / .env. */
  profile?: string;
  /** Default stage for deploy/destroy (default `"test"`). */
  stage?: string;
  /**
   * Engine-level adoption policy for this test run. When `true`, resources
   * without prior state will be adopted from the cloud via `provider.read`
   * (matching the CLI's `--adopt` flag). Defaults to `false`.
   */
  adopt?: boolean;
  /**
   * Run providers in local-dev mode (matching the CLI's `alchemy dev` flag).
   * When `true`, resources like Cloudflare Workers run locally via workerd
   * instead of being deployed to the cloud. When omitted, falls back to the
   * `ALCHEMY_DEV` environment variable (`"1"` / `"true"` enable it).
   */
  dev?: boolean;
}

/** Resolve the effective `dev` flag from explicit options or `ALCHEMY_DEV`. */
export const resolveDev = (options: { dev?: boolean }): boolean => {
  if (options.dev !== undefined) return options.dev;
  const env = process.env.ALCHEMY_DEV;
  return env === "1" || env?.toLowerCase() === "true";
};

const overrideAlchemyContext = (overrides: { dev: boolean }) =>
  Layer.effect(
    AlchemyContext,
    AlchemyContext.pipe(Effect.map((ctx) => ({ ...ctx, ...overrides }))),
  );

export type TestEffect<A, Req = never> = StackEffect<A, any, Req>;

const platformLayer = Layer.mergeAll(
  PlatformServices,
  FetchHttpClient.layer,
  Layer.provide(ProfileLive, PlatformServices),
  Layer.provide(CredentialsStoreLive, PlatformServices),
);

const alchemyLayer = Layer.mergeAll(LoggingCli, AlchemyContextLive);

/**
 * Build the per-test runtime and return a self-contained Effect.
 *
 * Mirrors {@link "../bin/alchemy.ts"} composition: ConfigProvider via
 * `loadConfigProvider` + `withProfileOverride`, an empty `AuthProviders`
 * registry that the user's `providers` layer populates, the platform layers,
 * and the configured state store. Adapters wrap this into runner-specific
 * thunks (`bun.test` -> `runPromise`, `it.live` -> as-is).
 *
 * When `scope` is provided, scoped resources (like the Cloudflare dev
 * sidecar) survive past this effect and are tied to the lifetime of the
 * provided scope instead. The runner is responsible for closing it.
 *
 * When `scope` is omitted, the effect runs with `Effect.scoped` and any
 * scoped resources are torn down as soon as it resolves.
 */
export const toEffect = <A>(
  effect: TestEffect<A>,
  options: MakeOptions,
  scope?: Scope.Scope,
): Effect.Effect<A, any, never> => {
  const base = Effect.gen(function* () {
    const cfg = yield* loadConfigProvider(Option.none());
    const configProvider = withProfileOverride(cfg, options.profile);
    return yield* effect.pipe(
      provideFreshArtifactStore,
      Effect.provide(Layer.succeed(ConfigProvider, configProvider)),
    );
  }).pipe(
    Effect.provideService(AdoptPolicy, options.adopt ?? false),
    Effect.provide(overrideAlchemyContext({ dev: resolveDev(options) })),
    // `options.state` (e.g. `Cloudflare.state()`) itself requires
    // `AuthProviders` to read credentials, so AuthProviders must be provided
    // AFTER the state layer or the state layer's requirement is never
    // satisfied — which surfaces as `Service not found: AuthProviders`.
    Effect.provide(options.state ?? State.localState()),
    Effect.provideService(AuthProviders, {}),
    Effect.provide(Layer.provideMerge(alchemyLayer, platformLayer)),
  );

  return (
    scope === undefined ? Effect.scoped(base) : Scope.provide(base, scope)
  ) as Effect.Effect<A, any, never>;
};

/** Promise wrapper around {@link toEffect} for `bun.test`-style runners. */
export const run = <A>(
  effect: TestEffect<A>,
  options: MakeOptions,
  scope?: Scope.Scope,
): Promise<A> => Effect.runPromise(toEffect(effect, options, scope));

/**
 * Wrap an effect so it runs with `options.providers` + a placeholder Stack +
 * Stage in scope. Used by `test.provider` so user code can call provider SDK
 * APIs (e.g. `DynamoDB.describeTable`) directly inside the test body.
 */
export const withProviders = <A, E, R, ROut>(
  effect: Effect.Effect<A, E, R>,
  options: MakeOptions<ROut>,
  stackName: string,
): Effect.Effect<A, E, Exclude<R, ROut | Stack | Stage>> =>
  effect.pipe(
    Effect.provide(options.providers as Layer.Layer<any, never, any>),
    Effect.provide(
      Layer.succeed(Stack, {
        name: stackName,
        stage: options.stage ?? "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
    ),
    Effect.provide(Layer.succeed(Stage, options.stage ?? "test")),
  ) as Effect.Effect<A, E, Exclude<R, ROut | Stack | Stage>>;

/**
 * Curried `deploy` for the test factory: bakes in the configured stage and
 * adds the telemetry layer the CLI uses, so `beforeAll(deploy(Stack))` works
 * the same way as `alchemy deploy`.
 *
 * `scope`, when supplied, is forwarded down so the dev sidecar (and other
 * scoped resources) lives until the caller closes it instead of dying as
 * soon as `deploy` resolves. The test harness uses this to keep workerd
 * alive across `beforeAll` → tests → `afterAll`.
 */
export const deploy = <A>(
  options: MakeOptions,
  stack: TestEffect<CompiledStack<A>, Stage | AlchemyContext>,
  callOptions?: { stage?: string; scope?: Scope.Scope },
) =>
  evalStack(
    stack,
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* Plan.make(stack);
        const output = yield* apply(plan);
        yield* tail(stack).pipe(
          Effect.tap(() => Effect.log(`${stack.name}: tailing stack`)),
          Effect.tapError((error) =>
            Effect.log(`${stack.name}: error tailing stack: ${error}`),
          ),
          Effect.tapDefect((defect) =>
            Effect.log(`${stack.name}: defect tailing stack: ${defect}`),
          ),
          Effect.tap(
            Effect.addFinalizer(() =>
              Effect.log(`${stack.name}: finalizing tail`),
            ),
          ),
          Effect.forkScoped,
        );
        return output as Input.Resolve<A>;
      }),
    {
      stage: callOptions?.stage ?? options.stage ?? "test",
      dev: resolveDev(options),
      scope: callOptions?.scope,
    },
  );

export const destroy = (
  options: MakeOptions,
  stack: TestEffect<CompiledStack, Stage | AlchemyContext>,
  callOptions?: { stage?: string; scope?: Scope.Scope },
) =>
  _destroy({
    stack: stack as Effect.Effect<CompiledStack, never, any>,
    stage: callOptions?.stage ?? options.stage ?? "test",
    dev: resolveDev(options),
    scope: callOptions?.scope,
  }).pipe(Effect.provide(TelemetryLive));

/**
 * In-test scratch stack handed to `test.provider(name, (stack) => ...)`.
 *
 * Each scratch stack owns a private in-memory state store that is shared
 * between successive `deploy`/`destroy` calls AND visible to the user's test
 * body (so `yield* State` / `state.get(...)` see the same store the deploys
 * mutated). This makes create / update / replace / delete paths exercisable
 * without polluting `.alchemy/` or other tests in the same file.
 */
export interface ScratchStack<ROut = any> {
  readonly name: string;
  /** The shared in-memory state Layer for this scratch. @internal */
  readonly state: Layer.Layer<State.State, never, never>;
  deploy<A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<Input.Resolve<A>, any, Exclude<R, ROut | StackServices>>;
  /**
   * Build a plan against the scratch's shared state WITHOUT applying it.
   *
   * Use this to assert on the planned action for a resource (e.g. that a
   * downstream dependency stays `noop` when only an upstream resource
   * changes) without mutating the cloud. Plans run against whatever state
   * prior `deploy(...)` calls persisted.
   */
  plan<A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<Plan.Plan<A>, any, Exclude<R, ROut | StackServices>>;
  destroy(): Effect.Effect<void, any, never>;
}

const sanitizeStackName = (name: string) =>
  name.replaceAll(/[^a-zA-Z0-9_]/g, "-").replace(/-+/g, "-");

/**
 * Build a fresh `ScratchStack` for `test.provider`. Allocates a private
 * in-memory state store so the test is isolated from `.alchemy/` and from
 * other tests in the same file.
 */
export const scratchStack = <ROut>(
  options: MakeOptions<ROut>,
  name: string,
): ScratchStack<ROut> => {
  const stage = options.stage ?? "test";
  const stackName = sanitizeStackName(name);
  const inMemory: Record<
    string,
    Record<string, Record<string, State.ResourceState>>
  > = {};
  const stateLayer = Layer.succeed(
    State.State,
    State.InMemoryService(inMemory),
  );
  const tailScope = Ref.makeUnsafe<Scope.Closeable | undefined>(undefined);

  const closeTail = () =>
    Ref.get(tailScope).pipe(
      Effect.tap(() => Effect.log(`${stackName}: closing tail`)),
      Effect.flatMap((scope) => {
        if (!scope) return Effect.void;
        return Effect.all([
          Ref.set(tailScope, undefined),
          Scope.close(scope, Exit.void),
        ]);
      }),
    );

  const tailStack = (stack: CompiledStack<any, any>) =>
    closeTail().pipe(
      Effect.andThen(Effect.scope),
      Effect.flatMap(Scope.fork),
      Effect.tap((scope) => Ref.set(tailScope, scope)),
      Effect.flatMap((scope) =>
        tail(stack).pipe(
          Effect.tap(() => Effect.log(`${stackName}: tailing stack`)),
          Effect.tapError((error) =>
            Effect.log(`${stackName}: error tailing stack: ${error}`),
          ),
          Effect.tapDefect((defect) =>
            Effect.log(`${stackName}: defect tailing stack: ${defect}`),
          ),
          Effect.forkScoped,
          Scope.provide(scope),
        ),
      ),
    );

  const buildAndApply = (effect: Effect.Effect<any, any, any>) =>
    (effect as Effect.Effect<any, any, never>).pipe(
      makeStack({
        name: stackName,
        providers: options.providers,
        state: stateLayer,
      } as any),
      Effect.flatMap((compiled) =>
        Plan.make(compiled).pipe(
          Effect.flatMap(apply),
          Effect.tap(tailStack(compiled)),
          Effect.provide(compiled.services),
        ),
      ),
      Effect.provide(Layer.succeed(Stage, stage)),
      provideFreshArtifactStore,
    );

  const buildPlan = (effect: Effect.Effect<any, any, any>) =>
    (effect as Effect.Effect<any, any, never>).pipe(
      makeStack({
        name: stackName,
        providers: options.providers,
        state: stateLayer,
      } as any) as any,
      Effect.flatMap((compiled: any) =>
        Plan.make(compiled).pipe(Effect.provide(compiled.services)),
      ),
      Effect.provide(Layer.succeed(Stage, stage)),
      provideFreshArtifactStore,
    );

  return {
    name: stackName,
    state: stateLayer,
    deploy: ((effect: Effect.Effect<any, any, any>) =>
      buildAndApply(effect)) as ScratchStack<ROut>["deploy"],
    plan: ((effect: Effect.Effect<any, any, any>) =>
      buildPlan(effect)) as ScratchStack<ROut>["plan"],
    destroy: () =>
      Plan.make({
        name: stackName,
        stage,
        resources: {},
        bindings: {},
        actions: {},
        output: {},
      }).pipe(
        Effect.tap(closeTail),
        Effect.flatMap(apply),
        Effect.asVoid,
        Effect.provide(stateLayer),
        Effect.provide(options.providers as Layer.Layer<any, never, any>),
        Effect.provide(
          Layer.succeed(Stack, {
            name: stackName,
            stage,
            resources: {},
            bindings: {},
            actions: {},
          }),
        ),
        Effect.provide(Layer.succeed(Stage, stage)),
        provideFreshArtifactStore,
      ) as Effect.Effect<void, any, never>,
  };
};
