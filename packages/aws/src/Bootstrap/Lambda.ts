/**
 * Bootstrap for `AWS.Lambda.Function` (zip, Node runtime). The generated
 * entry imports this module and the user's `main`, and re-exports the
 * handler this returns — see `alchemy/Runtime/Bootstrap` for why the entry is a
 * shim.
 */
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import * as Region from "@distilled.cloud/aws/Region";
import { getCallerIdentity } from "@distilled.cloud/aws/sts";
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { reifyBoundConfigProvider } from "alchemy/Runtime";
import { entrypointLayer, entrypointTag, stackFromEnv } from "alchemy/Runtime/Bootstrap";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import { layerWebCrypto as secureRandomLayer } from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { layer as fetchHttpClientLayer } from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { MinimumLogLevel } from "effect/References";
import * as Scope from "effect/Scope";
import { AWSEnvironment } from "../Environment.ts";
import { registerLambdaExtension } from "../Lambda/RuntimeExtension.ts";

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
    secureRandomLayer,
    // TODO(sam): wire this up to telemetry more directly
    Logger.layer([Logger.consolePretty()]),
  );

  // `AWSEnvironment` is a Function service. Build it from the credentials,
  // region and endpoint this sandbox already has. `AWS_ACCOUNT_ID` wins;
  // otherwise one STS call, against that endpoint, is cached for the sandbox.
  // Auth's `getAccountId` is the wrong call here: it forces `Endpoint.none`
  // so deploy-time resolution cannot deadlock on `AWSEnvironment`, and that
  // would send this call to AWS.
  const awsEnvironment = Layer.effect(
    AWSEnvironment,
    Effect.gen(function* () {
      // The AWS credential service's error channel also carries
      // `ConfigProvider.SourceError`. `AWSEnvironmentShape` keeps the
      // credential effect at `CredentialsError`, so a config-source failure
      // dies here instead of widening that channel.
      const credentials = (yield* Credentials.Credentials).pipe(
        Effect.catchTag("SourceError", (cause) => Effect.die(cause)),
      );
      const region = yield* Region.Region;
      const endpoint = yield* Endpoint.Endpoint;
      const httpClient = yield* HttpClient.HttpClient;
      const configProvider = yield* ConfigProvider.ConfigProvider;
      return yield* Effect.cached(
        Effect.gen(function* () {
          const resolvedRegion = yield* region;
          const resolvedEndpoint = yield* endpoint;
          const configured = yield* Config.option(Config.String("AWS_ACCOUNT_ID"));
          let accountId: string;
          if (Option.isSome(configured)) {
            accountId = configured.value;
          } else {
            const identity = yield* getCallerIdentity({});
            if (identity.Account === undefined) {
              return yield* Effect.die("STS GetCallerIdentity returned no account");
            }
            accountId = identity.Account;
          }
          return {
            accountId,
            region: resolvedRegion,
            credentials,
            endpoint: resolvedEndpoint,
          };
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(Credentials.Credentials, credentials),
              Layer.succeed(Region.Region, region),
              Layer.succeed(Endpoint.Endpoint, endpoint),
              Layer.succeed(HttpClient.HttpClient, httpClient),
              Layer.succeed(ConfigProvider.ConfigProvider, configProvider),
            ),
          ),
          Effect.orDie,
        ),
      );
    }),
  );

  const entryLayer = entrypointLayer(entrypoint).pipe(
    Layer.provideMerge(stackFromEnv),
    Layer.provideMerge(awsEnvironment),
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
        // `{"_tag":"Redacted","value":...}` markers; reify them so a `Config`
        // re-read inside a handler decodes the raw source value.
        reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env),
      ),
    ),
    Layer.provideMerge(Layer.succeed(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info")),
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
      .catch((error) => console.error("[alchemy] shutdown finalizers failed", error))
      .finally(() => process.exit(0));
  });

  return handler;
};
