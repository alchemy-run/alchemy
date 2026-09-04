/**
 * Process bootstrap for the hosted `AWS.EC2.Instance` program (a systemd
 * unit running bun). The generated entry imports this module and the user's
 * `main`, nothing else — see {@link ./Process.ts} for why.
 */
import {
  Credentials,
  fromChain as credentialsFromChain,
} from "@distilled.cloud/aws/Credentials";
import { fromEnv as endpointFromEnv } from "@distilled.cloud/aws/Endpoint";
import { Region, fromEnv as regionFromEnv } from "@distilled.cloud/aws/Region";
import { BunServices } from "@effect/platform-bun";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { LOCAL_ACCOUNT_ID } from "../../AWS/AuthProvider.ts";
import {
  AWSEnvironment,
  type AWSEnvironmentShape,
} from "../../AWS/Environment.ts";
import { BunHttpServer } from "../../Http.ts";
import { reifyBoundConfigProvider } from "../../Runtime.ts";
import {
  entrypointLayer,
  resolveProgram,
  runProcess,
  stackFromEnv,
} from "./Process.ts";

// Named imports + shared layer refs: `import * as Credentials` then
// `yield* Credentials` yields the module namespace (TypeError at boot),
// and `Layer.provideMerge(awsEnv)` does not feed IMDS credentials INTO
// the environment layer — it only exposes them to the program.
const credentialsLayer = credentialsFromChain();
const regionLayer = regionFromEnv();
const endpointLayer = endpointFromEnv();

/**
 * `SQSQueueEventSource` (and any `yield*` of an AWS resource provider)
 * requires `AWS::Environment`. Build it from the same IMDS/env chain the
 * distilled clients use — never the CLI profile store.
 */
const awsEnvironmentLayer = Layer.effect(
  AWSEnvironment,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const resolveRegion = yield* Region;
    const region = yield* resolveRegion;
    return Effect.succeed({
      accountId: process.env.AWS_ACCOUNT_ID ?? LOCAL_ACCOUNT_ID,
      region,
      credentials,
      endpoint: process.env.AWS_ENDPOINT_URL,
    } satisfies AWSEnvironmentShape);
  }),
).pipe(Layer.provide(credentialsLayer), Layer.provide(regionLayer));

/** Serve the bundled program with a Bun HTTP server on the instance's `PORT`. */
export const bootstrap = (entrypoint: unknown): Promise<void> => {
  const platform = Layer.mergeAll(
    BunServices.layer,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  );

  const program = resolveProgram("program", { telemetry: true }).pipe(
    Effect.provide(
      entrypointLayer(entrypoint).pipe(
        Layer.provideMerge(stackFromEnv),
        // The instance profile: credentials come from IMDS, not the env.
        Layer.provideMerge(credentialsLayer),
        Layer.provideMerge(regionLayer),
        // AWS_ENDPOINT_URL is injected by floci into guest containers —
        // without it, runtime bindings in `alchemy dev` would call REAL
        // AWS with dummy credentials. Unset on live deploys.
        Layer.provideMerge(endpointLayer),
        Layer.provideMerge(awsEnvironmentLayer),
        Layer.provideMerge(BunHttpServer()),
        Layer.provideMerge(platform),
        Layer.provideMerge(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env),
          ),
        ),
      ),
    ),
    Effect.scoped,
  );

  return runProcess("Instance", program);
};
