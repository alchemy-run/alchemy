import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { pathToFileURL } from "node:url";
import { AuthProviders } from "../Auth/AuthProvider.ts";
import { withProfileOverride } from "../Auth/Profile.ts";
import { AwsAuth } from "../AWS/AuthProvider.ts";
import { AxiomAuth } from "../Axiom/AuthProvider.ts";
import { CloudflareAuth } from "../Cloudflare/Auth/AuthProvider.ts";
import { GitHubAuth } from "../GitHub/AuthProvider.ts";
import { HetznerAuth } from "../Hetzner/AuthProvider.ts";
import { NeonAuth } from "../Neon/AuthProvider.ts";
import { PlanetscaleAuth } from "../Planetscale/AuthProvider.ts";
import { PrismaAuth } from "../Prisma/AuthProvider.ts";
import * as Stack from "../Stack.ts";
import { Stage } from "../Stage.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";
import { fileLogger } from "../Util/FileLogger.ts";

export class StackEntrypointError extends Data.TaggedError(
  "StackEntrypointError",
)<{ readonly message: string }> {}

export const importStack = Effect.fn(function* (main: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.resolve(main);
  if (!(yield* fs.exists(absolutePath))) {
    return yield* Effect.fail(
      new StackEntrypointError({
        message: `Stack entrypoint '${main}' does not exist in '${path.dirname(absolutePath)}'. Run this command from an Alchemy project or pass --config <path>.`,
      }),
    );
  }
  const module = yield* Effect.promise(
    () => import(pathToFileURL(absolutePath).href),
  );
  const stackEffect = module.default as ReturnType<
    ReturnType<typeof Stack.make>
  >;
  if (!Effect.isEffect(stackEffect)) {
    return yield* Effect.fail(
      new StackEntrypointError({
        message: `Stack entrypoint '${main}' must export a default stack definition (export default Alchemy.Stack({...})).`,
      }),
    );
  }
  return stackEffect as typeof stackEffect & {
    stackName: string;
    stage: string;
    providers: Layer.Layer<never>;
    state: Layer.Layer<never>;
  };
});

const placeholderStack = (name: string) => ({
  actions: {},
  bindings: {},
  name,
  resources: {},
  stage: "placeholder",
});

export interface BuildStackProvidersOptions {
  readonly main: string;
  readonly envFile: Option.Option<string>;
  readonly profile: string;
  readonly registry?: AuthProviders["Service"];
  readonly logger?: Layer.Layer<never, never, never>;
  readonly extra?: Layer.Layer<never, never, never>;
}

export const buildStackProviders = Effect.fn("buildStackProviders")(function* (
  options: BuildStackProvidersOptions,
) {
  const authProviders = options.registry ?? {};
  const stackEffect = yield* importStack(options.main);
  const configProvider = withProfileOverride(
    yield* loadConfigProvider(options.envFile),
    options.profile,
  );
  const valueServices = Layer.succeedContext(
    Context.make(AuthProviders, authProviders).pipe(
      Context.add(Stage, "placeholder"),
      Context.add(Stack.Stack, placeholderStack(stackEffect.stackName)),
    ),
  );
  const context = yield* Layer.build(
    (stackEffect.providers ?? Layer.empty).pipe(
      Layer.provideMerge(stackEffect.state ?? Layer.empty),
      Layer.provideMerge(
        Layer.mergeAll(
          valueServices,
          ConfigProvider.layer(configProvider),
          options.logger ??
            Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
          options.extra ?? Layer.empty,
        ),
      ),
    ),
  );
  return { authProviders, context, stackEffect };
});

export const builtinAuth = Layer.mergeAll(
  AwsAuth,
  AxiomAuth,
  CloudflareAuth,
  GitHubAuth,
  HetznerAuth,
  NeonAuth,
  PlanetscaleAuth,
  PrismaAuth,
);

export const buildBuiltinAuthProviders = Effect.fn("buildBuiltinAuthProviders")(
  function* (options: {
    readonly envFile: Option.Option<string>;
    readonly profile: string;
    readonly registry?: AuthProviders["Service"];
  }) {
    const authProviders = options.registry ?? {};
    yield* Layer.build(
      Layer.provide(
        builtinAuth,
        Layer.mergeAll(
          Layer.succeed(AuthProviders, authProviders),
          ConfigProvider.layer(
            withProfileOverride(
              yield* loadConfigProvider(options.envFile),
              options.profile,
            ),
          ),
          Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
        ),
      ),
    );
    return authProviders;
  },
);
