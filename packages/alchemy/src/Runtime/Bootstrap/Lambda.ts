/**
 * Bootstrap for `AWS.Lambda.Function` (zip, Node runtime). The generated
 * entry imports this module and the user's `main`, and re-exports the
 * handler this returns — see {@link ./Process.ts} for why the entry is a
 * shim.
 */
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import * as Region from "@distilled.cloud/aws/Region";
import { getCallerIdentity } from "@distilled.cloud/aws/sts";
import * as Config from "effect/Config";
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { MinimumLogLevel } from "effect/References";
import * as Scope from "effect/Scope";
import { layer as fetchHttpClientLayer } from "effect/unstable/http/FetchHttpClient";
import { AWSEnvironment } from "../../AWS/Environment.ts";
import { registerLambdaExtension } from "../../AWS/Lambda/RuntimeExtension.ts";
import { reifyBoundConfigProvider } from "../../Runtime.ts";
import { Stage } from "../../Stage.ts";
import { entrypointLayer, entrypointTag, stackFromEnv } from "./Process.ts";

/**
 * Build the sandbox-lifetime layer stack and return the Lambda handler the
 * bundled function registered.
 *
 * The layer build lives under an instance scope (not a transient
 * `Effect.provide`/`Effect.scoped` region) so services and init-level
 * finalizers live for the sandbox and are released at Shutdown — Lambda's
 * SIGTERM phase, which the internal extension registered here buys us
 * (without any registered extension the sandbox is killed with no signal at
 * all). Each invocation still gets its own request scope from the handler
 * dispatch.
 */
export const bootstrap = async (entrypoint: unknown): Promise<unknown> => {
  await registerLambdaExtension();

  const instanceScope = Scope.makeUnsafe();

  const platform = Layer.mergeAll(
    nodeServicesLayer,
    fetchHttpClientLayer,
    // TODO(sam): wire this up to telemetry more directly
    Logger.layer([Logger.consolePretty()]),
  );

  const awsEnvironment = Layer.effect(
    AWSEnvironment,
    Effect.gen(function* () {
      const credentials = yield* Credentials.Credentials;
      const region = yield* yield* Region.Region;
      const endpoint = yield* yield* Endpoint.Endpoint;
      const resolve = getCallerIdentity({}).pipe(
        Effect.map(({ Account }) => ({
          accountId: Account!,
          region,
          credentials,
          endpoint,
        })),
      );
      const context = yield* Effect.context<Effect.Services<typeof resolve>>();
      // Resolve account identity only when requested, once per sandbox.
      return yield* resolve.pipe(
        Effect.provideContext(context),
        Effect.orDie,
        Effect.cached,
      );
    }),
  ).pipe(
    Layer.provideMerge(Credentials.fromEnv()),
    Layer.provideMerge(Region.fromEnv()),
    Layer.provideMerge(Endpoint.fromEnv()),
  );

  const entryLayer = entrypointLayer(entrypoint).pipe(
    Layer.provideMerge(stackFromEnv),
    Layer.provideMerge(Layer.effect(Stage, Config.String("ALCHEMY_STAGE"))),
    Layer.provideMerge(awsEnvironment),
    Layer.provideMerge(platform),
    Layer.provideMerge(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        // Auto-bound `Config` values arrive in the env as
        // `{"_tag":"Redacted","value":...}` markers; reify them so a `Config`
        // re-read inside a handler decodes the raw source value.
        reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info"),
    ),
  );

  const handlerEffect: Effect.Effect<unknown, unknown> = Layer.buildWithScope(
    entryLayer,
    instanceScope,
  ).pipe(
    Effect.flatMap((context) =>
      entrypointTag.pipe(
        Effect.flatMap((func) => func.RuntimeContext.exports),
        Effect.flatMap((exports: any) => exports.handler),
        Effect.provideContext(context),
      ),
    ),
    Scope.provide(instanceScope),
  );

  const handler = await Effect.runPromise(handlerEffect);

  // Lambda's Shutdown phase: close the instance scope so init-level
  // finalizers run, then exit inside the 500 ms budget. SIGKILL follows if
  // we overstay, so finalizers must be fast and best-effort.
  process.on("SIGTERM", () => {
    console.log("[alchemy] SIGTERM — closing instance scope");
    Effect.runPromise(Scope.close(instanceScope, Exit.void))
      .catch((error) =>
        console.error("[alchemy] shutdown finalizers failed", error),
      )
      .finally(() => process.exit(0));
  });

  return handler;
};
