/**
 * The Lambda entry RUNTIME — the code the generated `FunctionBundle`
 * virtual entry used to carry as a string template, extracted into a real
 * module so plain effect Lambdas and the framework-composite wrapper
 * (`alchemy/AWS/Serve`) share one implementation:
 *
 * ```js
 * // the FunctionBundle virtual entry (generated, bundled into index.js)
 * import entrypoint from "<user main>";
 * import { makeFunctionEntrypoint } from "alchemy/AWS/Lambda/EntryRuntime";
 * export default await makeFunctionEntrypoint(entrypoint);
 * ```
 *
 * What it owns:
 *
 * - {@link registerEntrypointExtension} — the internal Lambda extension
 *   registration (buys the SIGTERM Shutdown window), registered once per
 *   sandbox no matter how many entries call it.
 * - {@link resolveFunctionHandler} — the shared "built Context → Lambda
 *   `(event, context)` handler" step: resolves the Function platform's
 *   `RuntimeContext.exports.handler` (the listener dispatch loop assembled
 *   in `Function.ts`) against a built service Context. The framework
 *   wrapper reuses this over the `alchemy/Serve` bridge's memoized build.
 * - {@link makeFunctionEntrypoint} — the whole plain-entry flow: instance
 *   scope, the sandbox layer stack (Credentials/Region/Endpoint from env,
 *   Node platform, packed-config reification), `Layer.buildWithScope`, and
 *   the SIGTERM close of the instance scope.
 */

import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import * as Region from "@distilled.cloud/aws/Region";
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { MinimumLogLevel } from "effect/References";
import * as Scope from "effect/Scope";
import { layer as fetchHttpClientLayer } from "effect/unstable/http/FetchHttpClient";
import {
  makeEntrypointLayer,
  reifyBoundConfigProvider,
} from "../../Runtime.ts";
import type { BaseRuntimeContext } from "../../RuntimeContext.ts";
import { Self } from "../../Self.ts";
import { Stack } from "../../Stack.ts";
import { registerLambdaExtension } from "./RuntimeExtension.ts";

/** The Lambda `(event, context)` handler shape the entry exports. */
export type LambdaEntryHandler = (event: any, context: any) => Promise<any>;

/**
 * Register the internal Lambda extension once per sandbox: it buys the
 * Shutdown phase (SIGTERM + 500 ms) — without any registered extension the
 * sandbox is killed with no signal at all, and init-level finalizers would
 * never run. Outside a Lambda sandbox (`AWS_LAMBDA_RUNTIME_API` unset) it
 * no-ops; errors are swallowed inside.
 */
let extension: Promise<unknown> | undefined;
export const registerEntrypointExtension = (): Promise<unknown> =>
  (extension ??= registerLambdaExtension());

/**
 * Resolve the Lambda `(event, context)` handler from a BUILT service
 * Context: the Function platform's `RuntimeContext.exports.handler` — the
 * listener dispatch loop (`serve`d HTTP listener, queue/stream/schedule
 * event-source listeners) assembled in `Function.ts`, with the
 * sandbox-lifetime services captured for per-invocation telemetry and
 * request scopes.
 */
const functionHandlerFromContext = (
  context: Context.Context<never>,
): Effect.Effect<LambdaEntryHandler> => {
  const tag = Self as any as Context.Service<
    never,
    { RuntimeContext: BaseRuntimeContext & { exports: Effect.Effect<any> } }
  >;
  return tag.pipe(
    Effect.flatMap((instance) => instance.RuntimeContext.exports),
    Effect.flatMap(
      (exports: { handler: Effect.Effect<LambdaEntryHandler> }) =>
        exports.handler,
    ),
    Effect.provideContext(context),
  );
};

export const resolveFunctionHandler = (
  context: Context.Context<never>,
): Promise<LambdaEntryHandler> =>
  Effect.runPromise(functionHandlerFromContext(context));

/**
 * The plain effect-Lambda entry: build the entrypoint's layer stack under
 * an instance scope (closed on SIGTERM inside the extension's Shutdown
 * window) and resolve the exported `(event, context)` handler. This is the
 * body the `FunctionBundle` virtual entry calls at module evaluation
 * (top-level await) — each invocation still gets its own request scope from
 * the handler dispatch.
 */
export const makeFunctionEntrypoint = async (
  entrypoint: object,
): Promise<LambdaEntryHandler> => {
  // Register before the layer build so the Shutdown window exists by the
  // time any init-level finalizer is registered.
  await registerEntrypointExtension();

  // Instance scope: the sandbox-lifetime layer build lives under it, and it
  // is closed on SIGTERM (Lambda's Shutdown phase) so init-level finalizers
  // run before the sandbox dies.
  const instanceScope = Scope.makeUnsafe();

  const tag = Self as any as Context.Service<
    never,
    { RuntimeContext: BaseRuntimeContext & { exports: Effect.Effect<any> } }
  >;
  const layer = makeEntrypointLayer(tag, entrypoint);

  const platform = Layer.mergeAll(
    nodeServicesLayer,
    fetchHttpClientLayer,
    // TODO(sam): wire this up to telemetry more directly
    Logger.layer([Logger.consolePretty()]),
  );

  const stack = Layer.effect(
    Stack,
    Effect.all([
      Config.string("ALCHEMY_STACK_NAME"),
      Config.string("ALCHEMY_STAGE"),
    ]).pipe(
      Effect.map(([name, stage]) => ({
        name,
        stage,
        bindings: {},
        resources: {},
        actions: {},
      })),
    ),
  ) as Layer.Layer<any>;

  const entryLayer = layer.pipe(
    Layer.provideMerge(stack),
    Layer.provideMerge(Credentials.fromEnv()),
    Layer.provideMerge(Region.fromEnv()),
    // AWS_ENDPOINT_URL is the LocalStack-standard override injected by local
    // emulators (floci) into the Lambda container — without it, runtime
    // bindings in `alchemy dev` would call REAL AWS with dummy credentials.
    // Resolves undefined when unset, so live deploys are unaffected.
    Layer.provideMerge(Endpoint.fromEnv()),
    Layer.provideMerge(platform),
    Layer.provideMerge(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        // Auto-bound `Config` values arrive in the env as
        // `{"_tag":"Redacted","value":...}` markers; reify them so a
        // `Config` re-read inside a handler decodes the raw source value.
        reifyBoundConfigProvider(
          ConfigProvider.fromEnv(),
          process.env as Record<string, unknown>,
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info"),
    ),
  );

  // Build the layer stack against the instance scope (not a transient
  // `Effect.provide`/`Effect.scoped` region) so services and init-level
  // finalizers live for the sandbox and are released at Shutdown.
  const handler = await Effect.runPromise(
    (
      Layer.buildWithScope(entryLayer, instanceScope) as Effect.Effect<
        Context.Context<never>,
        never,
        Scope.Scope
      >
    ).pipe(
      Effect.flatMap(functionHandlerFromContext),
      Scope.provide(instanceScope),
    ),
  );

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
