import { ConfigProvider } from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { Path } from "effect/Path";
import type { Scope } from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { AlchemyContext, AlchemyContextLive } from "./AlchemyContext.ts";
import { provideFreshArtifactStore } from "./Artifacts.ts";
import { AuthProviders } from "./Auth/AuthProvider.ts";
import { CredentialsStore, CredentialsStoreLive } from "./Auth/Credentials.ts";
import { Profile, ProfileLive } from "./Auth/Profile.ts";
import { Cli } from "./Cli/Cli.ts";
import type { Input, InputProps } from "./Input.ts";
import * as Output from "./Output.ts";
import { ref } from "./Ref.ts";
import type { ResourceBinding, ResourceLike } from "./Resource.ts";
import { Stage, type StageName } from "./Stage.ts";
import type { State } from "./State/State.ts";
import { loadConfigProvider } from "./Util/ConfigProvider.ts";
import { taggedFunction } from "./Util/effect.ts";
import { fileLogger } from "./Util/FileLogger.ts";
import { PlatformServices } from "./Util/PlatformServices.ts";

export type StackServices =
  | Stack
  | Stage
  | Scope
  | FileSystem
  | Path
  | AlchemyContext
  | HttpClient
  | ChildProcessSpawner
  | AuthProviders
  | Profile
  | CredentialsStore
  | Cli;

export type StackEffect<A, Err = never, Req = never> = Effect.Effect<
  A,
  Err,
  | PlatformServices
  | HttpClient
  | Scope
  | AuthProviders
  | AlchemyContext
  | Cli
  | Profile
  | CredentialsStore
  | State
  | Req
>;

export type Stack = Context.ServiceClass.Shape<
  "Stack",
  Omit<StackSpec, "output">
>;

export interface StackProps<Req> {
  providers: Layer.Layer<NoInfer<Req>, never, StackServices>;
  state: Layer.Layer<State, never, StackServices>;
  /**
   * Whitelist of stage names this stack accepts. When provided, the
   * `--stage` flag is validated against this list at runtime, and the
   * `alchemy types` command reads it to emit a `Stages` augmentation
   * that narrows `yield* Stage` to the union of these literals.
   *
   * Use `as const` so the literal types survive into the emitted
   * declaration:
   *
   * ```ts
   * Alchemy.Stack("Typebot", {
   *   stages: ["dev", "staging", "prod"] as const,
   *   providers: ...,
   *   state: ...,
   * }, body);
   * ```
   */
  stages?: readonly StageName[];
}

/**
 * Stage metadata attached to the `Effect` returned by `Alchemy.Stack(...)`.
 * The `alchemy types` CLI reads this off the imported default export to
 * emit the consumer-side type augmentation without compiling the stack.
 */
export interface StagesMeta {
  name: string;
  stages: readonly StageName[] | undefined;
}

export const STAGES_META: unique symbol = Symbol.for("alchemy.stages");

export const readStagesMeta = (value: unknown): StagesMeta | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const meta = (value as { [STAGES_META]?: unknown })[STAGES_META];
  return typeof meta === "object" && meta !== null
    ? (meta as StagesMeta)
    : undefined;
};

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
      options: StackProps<NoInfer<Req>>,
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
    options: StackProps<NoInfer<Req>>,
    eff: Effect.Effect<A, never, Req | StackServices>,
  ): Effect.Effect<CompiledStack<A>>;
} = Object.assign(
  taggedFunction(
    Context.Service<Stack, Omit<StackSpec, "output">>()("Stack"),
    <A, Req>(
      stackName: string,
      options: {
        providers: Layer.Layer<NoInfer<Req>, never, StackServices>;
        state: Layer.Layer<State, never, StackServices>;
        stages?: readonly StageName[];
      },
      eff: Effect.Effect<A, never, Req>,
    ) =>
      eff.pipe(
        make({
          name: stackName,
          ...options,
        }),
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
            // Surfaces the stages declared on the stack so the
            // `alchemy types` CLI can read them after `import()`-ing
            // the user's `alchemy.run.ts`, without compiling the
            // stack effect.
            [STAGES_META]: {
              name: stackName,
              stages: options.stages,
            } as StagesMeta,
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
}

export const StackName = Stack.use((stack) => Effect.succeed(stack.name));

export interface MakeStackProps<ROut = never> {
  name: string;
  providers: Layer.Layer<ROut, never, StackServices>;
  state: Layer.Layer<State, never, StackServices>;
  /** @internal */
  stack?: StackSpec;
}

export const make =
  <ROut = never>(options: MakeStackProps<ROut>) =>
  <A, Err = never, Req extends ROut | StackServices = never>(
    effect: Effect.Effect<A, Err, Req>,
  ) =>
    Effect.scope.pipe(
      Effect.flatMap((scope) => {
        if (options.state == null) {
          return Effect.die(
            new Error(
              `Stack "${options.name}" is missing a state store. ` +
                `Add a \`state\` layer to the stack options, e.g.:\n` +
                `  Alchemy.Stack("${options.name}", {\n` +
                `    providers: Cloudflare.providers(),\n` +
                `    state: Cloudflare.state(), // <-- required\n` +
                `  }, ...)\n` +
                `See https://v2.alchemy.run/concepts/state-store for available state stores.`,
            ),
          );
        }
        if (options.providers == null) {
          return Effect.die(
            new Error(
              `Stack "${options.name}" is missing a providers layer. ` +
                `Add a \`providers\` layer to the stack options, e.g.:\n` +
                `  Alchemy.Stack("${options.name}", {\n` +
                `    providers: Cloudflare.providers(), // <-- required\n` +
                `    state: Cloudflare.state(),\n` +
                `  }, ...)`,
            ),
          );
        }
        return options.providers.pipe(
          Layer.provideMerge(options.state),
          Layer.provideMerge(
            Layer.effect(
              Stack,
              Stage.asEffect().pipe(
                Effect.map(
                  (stage) =>
                    options.stack ?? {
                      name: options.name,
                      stage,
                      resources: {},
                      bindings: {},
                    },
                ),
              ),
            ),
          ),
          Layer.buildWithScope(scope),
        );
      }),
      Effect.flatMap((context) =>
        Effect.all([
          effect,
          Stack.asEffect(),
          Effect.context<ROut | StackServices>(),
        ]).pipe(
          Effect.map(
            ([output, stack, services]): CompiledStack<
              A,
              ROut | StackServices
            > => ({
              ...stack,
              output,
              services: Context.merge(services, context),
            }),
          ),
          Effect.provideContext(context),
        ),
      ),
    );

export const CurrentStack = Effect.serviceOption(Stack)
  .asEffect()
  .pipe(Effect.map(Option.getOrUndefined));

const platform = Layer.mergeAll(
  PlatformServices,
  FetchHttpClient.layer,
  Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
  Layer.provide(ProfileLive, PlatformServices),
  Layer.provide(CredentialsStoreLive, PlatformServices),
);
// override alchemy state store, CLI/reporting, state, and Config
const alchemy = (overrides?: { dev?: boolean }) =>
  Layer.mergeAll(
    // CLI.inkCLI(),
    // optional
    overrides?.dev
      ? Layer.provide(
          Layer.effect(
            AlchemyContext,
            AlchemyContext.asEffect().pipe(
              Effect.map((ctx) => ({ ...ctx, dev: overrides.dev! })),
            ),
          ),
          AlchemyContextLive,
        )
      : AlchemyContextLive,
  );

export const evalStack = <A, B, Err, Req>(
  effect: StackEffect<CompiledStack<A>, Stage | AlchemyContext>,
  fn: (stack: CompiledStack<A>) => Effect.Effect<B, Err, Req>,
  options: {
    stage: string;
    dev?: boolean;
  },
) =>
  Effect.gen(function* () {
    const stack = yield* effect;
    const configProvider = yield* loadConfigProvider(Option.none());

    return yield* fn(stack).pipe(
      provideFreshArtifactStore,
      Effect.provide(stack.services),
      Effect.provide(Layer.succeed(ConfigProvider, configProvider)),
    );
  }).pipe(
    Effect.provide(
      Layer.effect(
        AuthProviders,
        Effect.serviceOption(AuthProviders).pipe(
          Effect.map(Option.getOrElse(() => ({}))),
        ),
      ),
    ),
    Effect.provide(Layer.succeed(Stage, options.stage)),
    Effect.provide(Layer.provideMerge(alchemy({ dev: options.dev }), platform)),
    Effect.scoped,
  );
