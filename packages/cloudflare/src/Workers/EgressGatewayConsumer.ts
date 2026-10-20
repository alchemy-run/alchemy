import {
  EgressGatewayError,
  GatewayConsumer,
  type GatewayConnection,
  type GatewayHostShape,
  httpMint,
  type MintResult,
  type MintTransport,
  mintKeyPrefix,
} from "alchemy/Egress/Gateway";
import { EgressNotServed, type EgressRef } from "alchemy/Egress/Kind";
import { gatewayBindingName } from "alchemy/Egress/Route";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import { RpcCallError } from "alchemy/Rpc";
import { packEnvValue, RuntimeContext, sanitizeKey } from "alchemy/RuntimeContext";
/**
 * How a Worker or Durable Object reaches an egress gateway
 * (`alchemy/Egress/Gateway`): `Egress.GatewayConsumer`, provided to their
 * constructors. A Worker-hosted gateway is a service binding (`mint` over
 * Worker RPC); a Lambda Function, its function URL plus a direct
 * `lambda:InvokeFunction`; a Lambda Web Function, its endpoint plus a mint
 * key bound into both sides.
 */
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { makeRpcStub } from "./Rpc.ts";
import { Worker } from "./Worker.ts";
import { WorkerEnvironment } from "./WorkerRuntime.ts";

interface GatewayHostBase {
  readonly Type: string;
  readonly LogicalId: string;
}

/** An AWS Lambda Function host, read structurally (this package doesn't need `@alchemy.run/aws`). */
interface LambdaFunctionHost extends GatewayHostBase {
  readonly functionUrl: Output.Output<string | undefined>;
  readonly functionArn: Output.Output<string>;
}

/** An AWS Lambda Web Function host, read structurally. */
interface WebFunctionHost extends GatewayHostBase {
  readonly url: Output.Output<string>;
  readonly bind: Worker["bind"];
}

/** A Cloudflare Worker host. */
interface WorkerHost extends GatewayHostBase {
  readonly url: Output.Output<string | undefined>;
  readonly workerName: Output.Output<string>;
}

const isLambdaFunction = (host: GatewayHostBase): host is LambdaFunctionHost =>
  host.Type === "AWS.Lambda.Function";

const isWebFunction = (host: GatewayHostBase): host is WebFunctionHost =>
  host.Type === "AWS.Lambda.WebFunction";

/** Mint over the gateway Worker's service binding (Worker RPC). */
const serviceBindingMint = (
  id: string,
  name: string,
): Effect.Effect<MintTransport, never, WorkerEnvironment> =>
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const stub = makeRpcStub<{
      readonly mint: (
        refs: ReadonlyArray<EgressRef>,
        ttlMillis: number,
      ) => Effect.Effect<MintResult, EgressNotServed | RpcCallError>;
    }>(
      Effect.sync(() => (env as Record<string, unknown>)[name]),
      { errors: [EgressNotServed] },
    );
    return (refs, ttlMillis) =>
      stub.mint(refs, ttlMillis).pipe(
        Effect.catchTag("RpcCallError", (cause) =>
          Effect.fail(
            new EgressGatewayError({
              message: `gateway ${id} could not be reached`,
              gateway: id,
              cause,
            }),
          ),
        ),
      );
  });

/**
 * Mint with a direct `lambda:InvokeFunction` on the gateway's function,
 * signed with this Worker's AWS identity. Loaded only when a gateway is
 * hosted on Lambda, so other Workers never bundle the AWS SDK.
 */
const lambdaMint = (
  id: string,
  functionArn: Effect.Effect<string>,
  grantOn: Output.Output<string> | undefined,
): Effect.Effect<MintTransport> =>
  Effect.promise(() => import("@alchemy.run/aws/Lambda/EgressGatewayClient")).pipe(
    Effect.flatMap((client) => client.makeLambdaGatewayMint(id, functionArn, grantOn)),
  ) as Effect.Effect<MintTransport>;

const connect = Effect.fn(function* (id: string, hostShape: GatewayHostShape | undefined) {
  const name = gatewayBindingName(id);
  const urlKey = `${name}_URL`;
  const functionKey = `${name}_FUNCTION`;
  const mintKeyKey = `${name}_MINT_KEY`;
  const ctx = yield* RuntimeContext;
  if (hostShape) {
    const target: GatewayHostBase = yield* hostShape.host;
    const self = yield* Worker;
    const at = (base: string | undefined) => (base ? new URL(hostShape.path, base).toString() : "");
    const named = (output: Output.Output<string>, key: string) =>
      Output.named(output, key).asEffect() as unknown as Effect.Effect<
        Effect.Effect<string>,
        never,
        never
      >;
    if (isLambdaFunction(target)) {
      // Deploy: the function URL (the sandbox's traffic) and the function
      // ARN (`mint`, over IAM) into this Worker. No service binding.
      const url = yield* named(
        target.functionUrl.pipe(Output.map(at)) as Output.Output<string>,
        urlKey,
      );
      const functionArn = yield* named(target.functionArn, functionKey);
      return {
        url,
        transport: "lambda",
        mint: yield* lambdaMint(id, functionArn, target.functionArn),
      } satisfies GatewayConnection;
    }
    if (isWebFunction(target)) {
      // Deploy: a mint key for this Worker, bound into the gateway (which
      // accepts every consumer's key) and into this Worker; the endpoint
      // URL carries both the sandbox's traffic and `mint`.
      const url = yield* named(target.url.pipe(Output.map(at)) as Output.Output<string>, urlKey);
      const mintKey = yield* Random(`${id}MintKey${self.LogicalId}`, { bytes: 32 });
      yield* target.bind`EgressGatewayMint(${id}, ${self.LogicalId})`({
        env: {
          [`${mintKeyPrefix(id)}${sanitizeKey(self.LogicalId)}`]: mintKey.text.pipe(
            Output.map(packEnvValue),
          ),
        },
      });
      const key = (yield* Output.named(
        mintKey.text as Output.Output<Redacted.Redacted<string>>,
        mintKeyKey,
      ).asEffect()) as unknown as Effect.Effect<Redacted.Redacted<string>>;
      return { url, transport: "web", mint: httpMint(id, url, key) } satisfies GatewayConnection;
    }
    // Deploy: bind the gateway's Worker (a service binding, for mint) and
    // its URL (for the sandbox's traffic) into this Worker.
    const worker = target as WorkerHost;
    yield* self.bind`EgressGateway(${id})`({
      bindings: [{ type: "service", name, service: worker.workerName }],
    });
    const url = yield* named(worker.url.pipe(Output.map(at)) as Output.Output<string>, urlKey);
    return {
      url,
      transport: "worker",
      mint: yield* serviceBindingMint(id, name),
    } satisfies GatewayConnection;
  }
  const url = ctx.get<string>(sanitizeKey(urlKey)) as unknown as Effect.Effect<string>;
  // A Web Function-hosted gateway bound a mint key; a Lambda, its
  // function ARN; a Worker, a service binding.
  const mintKey = ctx.get<Redacted.Redacted<string> | string>(sanitizeKey(mintKeyKey));
  const functionArn = yield* ctx.get<string>(sanitizeKey(functionKey));
  if (yield* mintKey) {
    return { url, transport: "web", mint: httpMint(id, url, mintKey) } satisfies GatewayConnection;
  }
  if (functionArn) {
    return {
      url,
      transport: "lambda",
      mint: yield* lambdaMint(id, Effect.succeed(functionArn), undefined),
    } satisfies GatewayConnection;
  }
  return {
    url,
    transport: "worker",
    mint: yield* serviceBindingMint(id, name),
  } satisfies GatewayConnection;
});

/**
 * Provide `Egress.GatewayConsumer` to a Worker's or Durable Object's
 * constructor. It connects with the services ambient where the constructor
 * runs: the Worker (at deploy, to bind into) and its environment.
 */
export const provideGatewayConsumer = <A, E, R>(
  constructor: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, GatewayConsumer>> =>
  Effect.flatMap(Effect.context<never>(), (services) =>
    Effect.provideService(constructor, GatewayConsumer, {
      connect: (id, host) =>
        connect(id, host).pipe(
          Effect.provide(services as Context.Context<Worker | WorkerEnvironment>),
        ),
    }),
  );
