/**
 * Egress gateways (DESIGN.md §2, §4, §6, §9): a declaration names the
 * egresses a gateway serves by kind; `serve` turns an effectful constructor
 * into the gateway's implementation (`mint` grants, `fetch` granted
 * requests); `yield* Gateway` in a Durable Object or Worker gives the
 * egresses it can grant, and binds how to reach the gateway.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import type { Function as LambdaFunction } from "../AWS/Lambda/Function.ts";
import { makeRpcStub } from "../Cloudflare/Workers/Rpc.ts";
import { Worker } from "../Cloudflare/Workers/Worker.ts";
import { WorkerEnvironment } from "../Cloudflare/Workers/WorkerRuntime.ts";
import * as Output from "../Output.ts";
import { Random } from "../Random.ts";
import type { Rpc } from "../Rpc.ts";
import { RpcCallError } from "../Rpc.ts";
import { RuntimeContext, sanitizeKey } from "../RuntimeContext.ts";
import type { FunctionContext } from "../Serverless/Function.ts";
import { gatewayClient, registerGatewayClient } from "./Clients.ts";
import * as Grant from "./Grant.ts";
import { EgressSecretScope, makeEgressSecretScope } from "./Handler.ts";
import {
  type ConfiguredEgress,
  type EgressKind,
  EgressNotServed,
  type EgressRef,
  type KindName,
  type MintedGrant,
  type RouteSpec,
  type ScopeOf,
} from "./Kind.ts";
import { type EgressRouteConflict, gatewayBindingName, type Route, routesFor } from "./Route.ts";

//#region types

/** The egress kinds a gateway declares, by name. */
export type GatewayDeclaration = { readonly [name: string]: EgressKind<string, never> };

/**
 * The requirement `yield* Gateway` leaves for the stack: which host serves
 * the gateway. Provide it with `Gateway.host(worker)` or
 * `Gateway.host(lambdaFunction)`.
 */
export interface GatewayHost<Self> {
  readonly "~alchemy/Kind": "EgressGatewayHost";
  readonly "~alchemy/Self": Self;
}

/** What a gateway's constructor returns: one configured egress per declared name, of its kind. */
export type ConfiguredEgresses<D extends GatewayDeclaration> = {
  readonly [K in keyof D]: ConfiguredEgress<KindName<D[K]>>;
};

/** Names the constructor returns that the declaration doesn't. */
type NoExtra<A, D> = { readonly [K in Exclude<keyof A, keyof D>]: never };

/** A gateway's answer to `mint`, before the caller adds the gateway's address. */
export interface MintResult {
  readonly grant: string;
  readonly expires: number;
  readonly routes: ReadonlyArray<ReadonlyArray<RouteSpec>>;
}

/** The gateway's mint method, as served over RPC (TTL in milliseconds). */
export type MintMethod = (
  refs: ReadonlyArray<EgressRef>,
  ttlMillis: number,
) => Effect.Effect<MintResult, EgressNotServed, RuntimeContext>;

/**
 * The direct invoke a Lambda-hosted gateway answers `mint` on:
 * `{ "~alchemy/egress/mint": { refs, ttl } }`. A function URL request is a
 * different event shape, so `mint` is never reachable over the public URL.
 */
export const MINT_INVOKE = "~alchemy/egress/mint";

/** A direct invoke asking the gateway to mint. */
export interface MintInvoke {
  readonly [MINT_INVOKE]: { readonly refs: ReadonlyArray<EgressRef>; readonly ttl: number };
}

/** What a Lambda-hosted gateway answers a {@link MintInvoke} with. */
export type MintInvokeReply =
  | { readonly minted: MintResult }
  | { readonly refused: { readonly message: string; readonly egress?: string } };

export const isMintInvoke = (event: unknown): event is MintInvoke =>
  typeof event === "object" &&
  event !== null &&
  typeof (event as Record<string, unknown>)[MINT_INVOKE] === "object" &&
  Array.isArray((event as MintInvoke)[MINT_INVOKE]?.refs);

/** What `Gateway.serve` returns: a Worker (or Lambda) implementation. */
export type GatewayServer = {
  /** The sandbox's traffic: `Authorization: Macaroon <grant>`, `x-alchemy-target`, `x-alchemy-method`. */
  readonly fetch: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest | Scope.Scope | RuntimeContext
  >;
  /**
   * Sign a grant for refs to this gateway's egresses. Called over a service
   * binding (a Worker host) or a direct `lambda:InvokeFunction` (a Lambda
   * host), never over the public URL.
   */
  readonly mint: MintMethod;
};

/** The gateway couldn't be reached, or answered with something that isn't a grant. */
export class EgressGatewayError extends Data.TaggedError("EgressGatewayError")<{
  readonly message: string;
  readonly gateway: string;
  readonly cause?: unknown;
}> {}

/** How a Durable Object or Worker reaches one gateway at run time. */
export interface GatewayClient<G = unknown> {
  /** @internal phantom */
  readonly "~alchemy/Gateway"?: G;
  /** The gateway's id: `"WorkGateway"`. */
  readonly id: string;
  /** The egress kinds it serves, by name (from its declaration). */
  readonly kinds: GatewayDeclaration;
  /** Where the sandbox's traffic goes (the HTTPS transport). */
  readonly url: Effect.Effect<string, never, RuntimeContext>;
  /** How the gateway is hosted: a Worker (service binding) or a Lambda (function URL). */
  readonly transport: "worker" | "lambda";
  /** Ask the gateway to sign a grant: service binding RPC, or Lambda `InvokeFunction`. */
  readonly mint: (
    refs: ReadonlyArray<EgressRef>,
    ttl: Duration.Input,
  ) => Effect.Effect<MintedGrant, EgressNotServed | EgressGatewayError, RuntimeContext>;
}

/** An egress a Durable Object can grant to a sandbox. */
export interface GrantableEgress<G, E> {
  /** A value from this gateway can only be granted by it. */
  readonly gateway: GatewayClient<G>;
  /** Its kind: a sandbox only takes egresses of the kinds it accepts. */
  readonly kind: E;
  readonly ref: EgressRef;
  /** Restrict access (the scope type comes from the kind). */
  narrow(scope: ScopeOf<E>): GrantableEgress<G, E>;
  /** Choose whose credential to use (egresses whose credential is per subject). */
  for(subject: string): GrantableEgress<G, E>;
}

/** What `yield* Gateway` gives: each declared egress, grantable. */
export type GatewayEgresses<G, D extends GatewayDeclaration> = {
  readonly [K in keyof D]: GrantableEgress<G, D[K]>;
};

/** The instance type of a gateway declaration class. */
export interface GatewayInstance<Id extends string, D extends GatewayDeclaration> {
  readonly "~alchemy/GatewayId": Id;
  readonly "~alchemy/GatewayEgresses": D;
}

export interface GatewayHostOptions {
  /** The path the gateway is served under on its host, when it shares a Worker. @default "/" */
  readonly path?: string;
}

/** A gateway declaration: `class WorkGateway extends Egress.Gateway<WorkGateway>()(...) {}`. */
export interface GatewayClass<
  Self,
  Id extends string,
  D extends GatewayDeclaration,
> extends Effect.Effect<GatewayEgresses<Self, D>, never, GatewayHost<Self> | Worker> {
  new (_: never): GatewayInstance<Id, D>;
  /** The gateway's id. */
  readonly id: Id;
  /** The egress kinds it serves, by name. */
  readonly egresses: D;
  /**
   * The gateway's implementation from an effectful constructor that
   * configures every declared egress: a whole Worker (or Lambda)
   * implementation `{ fetch, mint }`, or `yield*` it inside a Worker you
   * already have and route to its `fetch` (return its `mint` too).
   */
  serve<A extends ConfiguredEgresses<D>, E, R>(
    implementation: Effect.Effect<A & NoExtra<A, D>, E, R>,
  ): Effect.Effect<GatewayServer, E, Exclude<R, EgressSecretScope>>;
  /**
   * Which Worker or Lambda Function serves this gateway: provide the
   * returned Layer to the stack, like a sandbox's host. The host's
   * implementation must be (or expose) this gateway's `serve`.
   *
   * A Worker is reached over a service binding (`mint` over Worker RPC,
   * traffic over the binding or its URL). A Lambda Function needs a function
   * URL: the sandbox's traffic goes to the URL, and `mint` is a direct
   * `lambda:InvokeFunction`, granted to whichever Worker yields the gateway
   * (the stack needs the AWS providers for that Worker's IAM identity).
   */
  host<R = never>(
    host: Effect.Effect<(Worker & Rpc<{ readonly mint: MintMethod }>) | LambdaFunction, never, R>,
    options?: GatewayHostOptions,
  ): Layer.Layer<GatewayHost<Self>, never, R>;
}

//#endregion

//#region runtime client registry

export { gatewayClient } from "./Clients.ts";

const grantable = <G, E>(
  client: GatewayClient<G>,
  kind: E,
  ref: EgressRef,
): GrantableEgress<G, E> => ({
  gateway: client,
  kind,
  ref,
  narrow: (scope) => grantable(client, kind, { ...ref, scope }),
  for: (subject) => grantable(client, kind, { ...ref, subject }),
});

/** The kind of a granted egress, if its gateway was yielded in this isolate. */
export const kindOf = (ref: EgressRef): EgressKind<string, never> | undefined => {
  const kinds = gatewayClient(ref.gateway)?.kinds;
  return kinds && Object.prototype.hasOwnProperty.call(kinds, ref.egress)
    ? kinds[ref.egress]
    : undefined;
};

/** The placeholder env a sandbox's programs need for `refs` (`GH_TOKEN=alchemy-egress`). */
export const placeholdersFor = (refs: ReadonlyArray<EgressRef>): Record<string, string> =>
  Object.assign({}, ...refs.map((ref) => kindOf(ref)?.env ?? {}));

/** Everything granting egresses to a sandbox can fail with. */
export type EgressError = EgressNotServed | EgressGatewayError | EgressRouteConflict;

//#endregion

//#region serve

/** Request headers that describe the hop to the gateway, not the request to the target. */
const GATEWAY_ONLY = new Set([
  "authorization",
  "host",
  "connection",
  "keep-alive",
  "content-length",
  "transfer-encoding",
  "accept-encoding", // fetch would decompress, leaving a stale content-encoding
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
  "x-alchemy-target",
  "x-alchemy-method",
  "x-real-ip",
  "cdn-loop",
  "true-client-ip",
]);
const isGatewayOnly = (name: string) =>
  GATEWAY_ONLY.has(name) ||
  name.startsWith("cf-") ||
  name.startsWith("x-forwarded-") ||
  name.startsWith("x-amzn-"); // a Lambda function URL's

const RESPONSE_DROP = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

const deny = (status: number, reason: string) =>
  HttpServerResponse.text(`alchemy egress: ${reason}\n`, { status });

/** Grants live at most this long, whatever the caller asks for. */
const MAX_TTL_MILLIS = 60 * 60 * 1000;

const makeServe =
  (id: string) =>
  <A, E, R>(implementation: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      // The signing key: generated once at deploy, bound into this host only.
      const random = yield* Random(`${id}Key`, { bytes: 32 });
      const keyText = (yield* random.text) as unknown as Effect.Effect<
        Redacted.Redacted<string> | string
      >;
      let key: Uint8Array | undefined;
      const signingKey = Effect.gen(function* () {
        if (key) return key;
        const text = yield* keyText;
        const bytes = Grant.fromHex(Redacted.isRedacted(text) ? Redacted.value(text) : text);
        if (!bytes || bytes.length === 0) {
          return yield* Effect.die(new Error(`egress gateway ${id}: its signing key is missing`));
        }
        key = bytes;
        return bytes;
      });

      const egresses = (yield* implementation.pipe(
        Effect.provideService(EgressSecretScope, makeEgressSecretScope()),
      )) as unknown as Record<string, ConfiguredEgress>;

      const egressFor = (name: string) =>
        Object.prototype.hasOwnProperty.call(egresses, name) ? egresses[name] : undefined;

      const mint: MintMethod = (refs, ttlMillis) =>
        Effect.gen(function* () {
          const routes: Array<ReadonlyArray<RouteSpec>> = [];
          const caveats: Array<Grant.EgressCaveat> = [];
          for (const ref of refs) {
            const egress = ref.gateway === id ? egressFor(ref.egress) : undefined;
            if (!egress) {
              return yield* new EgressNotServed({
                message: `${ref.gateway}.${ref.egress} is not served by ${id}`,
                gateway: id,
                egress: ref.egress,
              });
            }
            const request = { scope: ref.scope, subject: ref.subject };
            const served = egress.allows(request).pipe(Effect.andThen(egress.routes(request)));
            routes.push(
              yield* served.pipe(
                Effect.mapError(
                  (error) =>
                    new EgressNotServed({
                      message: `${id}.${ref.egress}: ${error.message}`,
                      gateway: id,
                      egress: ref.egress,
                    }),
                ),
              ),
            );
            caveats.push({
              egress: ref.egress,
              ...(ref.scope !== undefined ? { scope: ref.scope } : {}),
              ...(ref.subject !== undefined ? { subject: ref.subject } : {}),
            });
          }
          if (caveats.length === 0) {
            return yield* new EgressNotServed({ message: "no egress to grant", gateway: id });
          }
          const now = yield* Clock.currentTimeMillis;
          const ttl = Math.min(Math.max(Math.trunc(Number(ttlMillis) || 0), 1_000), MAX_TTL_MILLIS);
          const expires = now + ttl;
          const grantId = yield* Effect.sync(() => crypto.randomUUID());
          const grant = yield* Grant.mint(yield* signingKey, grantId, [
            { expires },
            caveats.length === 1 ? caveats[0]! : { anyOf: caveats },
          ]);
          return { grant: Grant.encode(grant), expires, routes } satisfies MintResult;
        });

      const routesOf = (caveat: Grant.EgressCaveat) =>
        (egressFor(caveat.egress)?.routes(caveat) ?? Effect.succeed([])).pipe(
          Effect.orElseSucceed((): ReadonlyArray<RouteSpec> => []),
        );

      const fetch = Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const decoded = yield* Effect.result(Grant.decode(request.headers.authorization));
        if (decoded._tag === "Failure") return deny(401, "no valid grant");
        const grant = decoded.success;
        if (!(yield* Grant.verify(yield* signingKey, grant))) return deny(401, "invalid grant");
        const now = yield* Clock.currentTimeMillis;
        if (Grant.isExpired(grant, now)) return deny(401, "the grant has expired");

        const targetHeader = request.headers["x-alchemy-target"];
        if (!targetHeader || !URL.canParse(targetHeader)) {
          return deny(400, "missing x-alchemy-target");
        }
        const target = new URL(targetHeader);
        const caveat = yield* Grant.covering(
          grant,
          { host: target.host, path: target.pathname },
          now,
          routesOf,
        );
        const egress = caveat && egressFor(caveat.egress);
        if (!caveat || !egress) {
          return deny(403, `${target.host}${target.pathname} is not granted`);
        }
        const handler = yield* Effect.result(egress.handler(caveat));
        if (handler._tag === "Failure") return deny(403, handler.failure.message);

        const method = (request.headers["x-alchemy-method"] ?? request.method).toUpperCase();
        const headers = Object.fromEntries(
          Object.entries(request.headers).filter(([name]) => !isGatewayOnly(name)),
        );
        let upstream = HttpClientRequest.make(method as "GET")(target.toString(), { headers });
        if (method !== "GET" && method !== "HEAD") {
          const length = Number(request.headers["content-length"]);
          upstream = HttpClientRequest.bodyStream(upstream, request.stream, {
            contentType: request.headers["content-type"],
            ...(Number.isFinite(length) && length >= 0 ? { contentLength: length } : {}),
          });
        }
        const decided = yield* handler.success(upstream);
        if (HttpServerResponse.isHttpServerResponse(decided)) return decided;
        const client = yield* HttpClient.HttpClient;
        const response = yield* Effect.result(client.execute(decided));
        if (response._tag === "Failure") {
          return deny(502, `upstream request failed: ${response.failure.message}`);
        }
        return HttpServerResponse.stream(response.success.stream, {
          status: response.success.status,
          headers: Object.fromEntries(
            Object.entries(response.success.headers).filter(
              ([name]) => !RESPONSE_DROP.has(name.toLowerCase()),
            ),
          ),
        });
      }).pipe(Effect.provide(FetchHttpClient.layer));

      // A host that takes raw invocations (a Lambda) answers `mint` on a
      // direct invoke, authorized by IAM. Its HTTP events (the function URL)
      // only ever reach `fetch`.
      const runtime = yield* Effect.serviceOption(RuntimeContext);
      const listen =
        runtime._tag === "Some" ? (runtime.value as Partial<FunctionContext>).listen : undefined;
      if (listen) {
        yield* listen((event: unknown) =>
          isMintInvoke(event)
            ? mint(event[MINT_INVOKE].refs, event[MINT_INVOKE].ttl).pipe(
                Effect.map((minted): MintInvokeReply => ({ minted })),
                Effect.catchTag("EgressNotServed", (error) =>
                  Effect.succeed<MintInvokeReply>({
                    refused: {
                      message: error.message,
                      ...(error.egress !== undefined ? { egress: error.egress } : {}),
                    },
                  }),
                ),
              )
            : undefined,
        );
      }

      return { fetch, mint } satisfies GatewayServer;
    });

//#endregion

interface GatewayHostShape {
  readonly host: Effect.Effect<Worker | LambdaFunction, never, any>;
  readonly path: string;
}

const LAMBDA_FUNCTION_TYPE = "AWS.Lambda.Function";

/** Recognized structurally, so this module never imports the AWS module graph. */
const isLambdaFunction = (host: Worker | LambdaFunction): host is LambdaFunction =>
  (host as { Type?: string }).Type === LAMBDA_FUNCTION_TYPE;

/** How `mint` reaches the gateway: plain RPC arguments, the gateway's typed errors. */
type MintTransport = (
  refs: ReadonlyArray<EgressRef>,
  ttlMillis: number,
) => Effect.Effect<MintResult, EgressNotServed | EgressGatewayError, RuntimeContext>;

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
  Effect.promise(() => import("../AWS/Lambda/EgressGatewayClient.ts")).pipe(
    Effect.flatMap((client) => client.makeLambdaGatewayMint(id, functionArn, grantOn)),
  ) as Effect.Effect<MintTransport>;

const makeClient = (
  id: string,
  hostTag: Context.Key<any, GatewayHostShape>,
  kinds: GatewayDeclaration,
) =>
  Effect.gen(function* () {
    const name = gatewayBindingName(id);
    const urlKey = `${name}_URL`;
    const functionKey = `${name}_FUNCTION`;
    const ctx = yield* RuntimeContext;
    let url: Effect.Effect<string>;
    let transport: GatewayClient["transport"];
    let mint: MintTransport;
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const host = yield* hostTag;
      const target = yield* host.host;
      const self = yield* Worker;
      const path = host.path;
      const at = (base: string | undefined) => (base ? new URL(path, base).toString() : "");
      if (isLambdaFunction(target)) {
        // Deploy: the function URL (the sandbox's traffic) and the function
        // ARN (`mint`, over IAM) into this Worker. No service binding.
        const publicUrl = target.functionUrl.pipe(Output.map(at)) as Output.Output<string>;
        url = (yield* Output.named(
          publicUrl,
          urlKey,
        ).asEffect()) as unknown as Effect.Effect<string>;
        const functionArn = (yield* Output.named(
          target.functionArn as Output.Output<string>,
          functionKey,
        ).asEffect()) as unknown as Effect.Effect<string>;
        transport = "lambda";
        mint = yield* lambdaMint(id, functionArn, target.functionArn as Output.Output<string>);
      } else {
        // Deploy: bind the gateway's Worker (a service binding, for mint) and
        // its URL (for the sandbox's traffic) into this Worker.
        yield* self.bind`EgressGateway(${id})`({
          bindings: [{ type: "service", name, service: target.workerName }],
        });
        const publicUrl = target.url.pipe(Output.map(at)) as Output.Output<string>;
        url = (yield* Output.named(
          publicUrl,
          urlKey,
        ).asEffect()) as unknown as Effect.Effect<string>;
        transport = "worker";
        mint = yield* serviceBindingMint(id, name);
      }
    } else {
      url = ctx.get<string>(sanitizeKey(urlKey)) as unknown as Effect.Effect<string>;
      // A Lambda-hosted gateway bound its function ARN; a Worker, a service binding.
      const functionArn = yield* ctx.get<string>(sanitizeKey(functionKey));
      if (functionArn) {
        transport = "lambda";
        mint = yield* lambdaMint(id, Effect.succeed(functionArn), undefined);
      } else {
        transport = "worker";
        mint = yield* serviceBindingMint(id, name);
      }
    }
    const client: GatewayClient = {
      id,
      kinds,
      url,
      transport,
      mint: (refs, ttl) =>
        Effect.gen(function* () {
          const result = yield* mint(refs, Duration.toMillis(ttl));
          return { gateway: { id, url: yield* url }, ...result } satisfies MintedGrant;
        }),
    };
    registerGatewayClient(client);
    return client;
  });

/**
 * An egress gateway: a declaration that names the egresses it serves by
 * kind. It holds no configuration and no credentials, so it is cheap to
 * import anywhere. A sandbox holds no credentials either: its requests to
 * egress hosts go to the gateway with a short-lived signed grant, and the
 * gateway checks them against the egress rules, adds the real credential and
 * forwards them.
 *
 * ### Declaring a gateway
 * **Example:** Two egresses, by kind
 * ```typescript
 * import * as Anthropic from "alchemy/Anthropic";
 * import * as Egress from "alchemy/Egress";
 * import * as GitHub from "alchemy/GitHub";
 *
 * export class WorkGateway extends Egress.Gateway<WorkGateway>()("WorkGateway", {
 *   model: Anthropic.Egress,
 *   repo: GitHub.Egress,
 * }) {}
 * ```
 *
 * ### Serving a gateway
 * **Example:** A Worker that configures each egress
 * ```typescript
 * export default Cloudflare.Worker(
 *   "WorkGatewayWorker",
 *   { main: import.meta.url },
 *   WorkGateway.serve(
 *     Effect.gen(function* () {
 *       return {
 *         model: yield* Anthropic.Egress({ apiKey: Config.Redacted("ANTHROPIC_API_KEY") }),
 *         repo: yield* GitHub.Egress({
 *           token: GitHub.ProfileToken,
 *           repositories: [{ repository: "alchemy-run/alchemy", contents: "write" }],
 *         }),
 *       };
 *     }),
 *   ),
 * );
 * ```
 *
 * **Example:** A credential per subject, from a database
 * ```typescript
 * UserGateway.serve(
 *   Effect.gen(function* () {
 *     const tokens = yield* Cloudflare.KV.ReadNamespace(Tokens);
 *     return {
 *       repo: yield* GitHub.Egress({
 *         // `subject` comes from the signed grant (`for(subject)`).
 *         token: ({ subject }) =>
 *           tokens.get(subject).pipe(Effect.map((token) => token ?? "")),
 *       }),
 *     };
 *   }),
 * );
 * ```
 *
 * ### Choosing the gateway's host
 * **Example:** Provide the hosting Worker to the stack
 * ```typescript
 * export default Alchemy.Stack(
 *   "Harness",
 *   { providers: Cloudflare.providers(), state: Alchemy.localState() },
 *   Effect.gen(function* () {
 *     const api = yield* Api;
 *     return { url: api.url.as<string>() };
 *   }).pipe(Effect.provide(WorkGateway.host(WorkGatewayWorker))),
 * );
 * ```
 *
 * ### Hosting a gateway on AWS Lambda
 * A Lambda Function with a function URL serves the same `serve`. The
 * sandbox's traffic goes to the function URL; `mint` is answered only on a
 * direct `lambda:InvokeFunction`, which `yield* Gateway` grants to the
 * consuming Worker's IAM identity (so the stack needs the AWS providers).
 *
 * **Example:** A Lambda gateway with credentials from DynamoDB
 * ```typescript
 * // src/gateway.lambda.ts
 * export default AWS.Lambda.Function(
 *   "UserGatewayLambda",
 *   { main: import.meta.url, functionUrl: true },
 *   UserGateway.serve(
 *     Effect.gen(function* () {
 *       const credentials = yield* AWS.DynamoDB.GetItem(Credentials);
 *       const lookup = (subject: string) =>
 *         credentials({ Key: { subject: { S: subject } } }).pipe(Effect.map(({ Item }) => Item!));
 *       return {
 *         repo: yield* GitHub.Egress({
 *           token: ({ subject }) => lookup(subject).pipe(Effect.map((item) => item.githubToken.S!)),
 *         }),
 *         custom: yield* Egress.Http({
 *           credential: ({ subject }) => lookup(subject).pipe(Effect.map(toHttpCredential)),
 *         }),
 *       };
 *     }).pipe(Effect.provide(AWS.DynamoDB.GetItemHttp)),
 *   ),
 * );
 * ```
 *
 * **Example:** Provide the Lambda as the gateway's host
 * ```typescript
 * export default Alchemy.Stack(
 *   "Harness",
 *   {
 *     providers: Layer.mergeAll(Cloudflare.providers(), AWS.providers()),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     const api = yield* Api; // a Worker whose Durable Object yields UserGateway
 *     return { url: api.url.as<string>() };
 *   }).pipe(Effect.provide(UserGateway.host(UserGatewayLambda))),
 * );
 * ```
 *
 * ### Granting egresses
 * **Example:** Narrow an egress and choose whose credential it uses
 * ```typescript
 * export class Agent extends Cloudflare.DurableObject<Agent>()(
 *   "Agent",
 *   Effect.gen(function* () {
 *     const work = yield* WorkGateway;
 *     const user = yield* UserGateway;
 *     return Effect.gen(function* () {
 *       return {
 *         routes: (issue: number, userId: string) =>
 *           Egress.grant([
 *             work.model,
 *             work.repo.narrow({ repository: "alchemy-run/alchemy", issue }),
 *             user.repo.narrow({ repository: "sam/dotfiles", graphql: false }).for(userId),
 *           ]),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @binding
 * @product Egress
 * @category Egress
 */
export const Gateway =
  <Self>() =>
  <const Id extends string, const D extends GatewayDeclaration>(
    id: Id,
    egresses: D,
  ): GatewayClass<Self, Id, D> => {
    const hostTag = Context.Service<GatewayHost<Self>, GatewayHostShape>(
      `alchemy/Egress/GatewayHost<${id}>`,
    );
    class GatewayDeclarationClass {
      static readonly id = id;
      static readonly egresses = egresses;
      static serve = makeServe(id);
      static host = (
        host: Effect.Effect<Worker | LambdaFunction, never, any>,
        options: GatewayHostOptions = {},
      ) => Layer.succeed(hostTag, { host, path: options.path ?? "/" });
    }
    return Object.assign(
      GatewayDeclarationClass,
      Effectable.Prototype({
        label: `Egress.Gateway<${id}>`,
        evaluate: () =>
          Effect.map(makeClient(id, hostTag, egresses), (client) =>
            Object.fromEntries(
              Object.keys(egresses).map((name) => [
                name,
                grantable(client, egresses[name], { gateway: id, egress: name }),
              ]),
            ),
          ),
      }),
    ) as unknown as GatewayClass<Self, Id, D>;
  };

//#region granting

/** Options for {@link grant}. */
export interface GrantOptions {
  /** Each grant's lifetime. @default "5 minutes" */
  readonly ttl?: Duration.Input;
}

/** The result of {@link grant}: the route table, and each gateway's minted grant. */
export interface Granted {
  readonly routes: ReadonlyArray<Route>;
  readonly minted: Readonly<Record<string, MintedGrant>>;
}

/**
 * Mint one grant per gateway for `egresses` and build the sandbox's route
 * table (DESIGN.md §10): host and path to gateway, with that gateway's grant.
 * Fails with `EgressNotServed` when a gateway refuses an egress, and
 * `EgressRouteConflict` when two egresses claim the same requests. Runs where
 * the gateways were yielded (a Durable Object or Worker):
 *
 * ```typescript
 * const work = yield* WorkGateway;
 * // ...at run time:
 * const { routes } = yield* Egress.grant(
 *   [work.model, work.repo.narrow({ repository: "alchemy-run/alchemy", issue: 42 })],
 *   { ttl: "5 minutes" },
 * );
 * ```
 */
export const grant = (
  egresses: ReadonlyArray<GrantableEgress<any, any> | EgressRef>,
  options: GrantOptions = {},
): Effect.Effect<
  Granted,
  EgressNotServed | EgressGatewayError | EgressRouteConflict,
  RuntimeContext
> =>
  Effect.gen(function* () {
    const refs = egresses.map((egress) => ("ref" in egress ? egress.ref : egress));
    const byGateway = new Map<string, Array<EgressRef>>();
    for (const ref of refs)
      byGateway.set(ref.gateway, [...(byGateway.get(ref.gateway) ?? []), ref]);
    const minted: Record<string, MintedGrant> = {};
    for (const [gatewayId, gatewayRefs] of byGateway) {
      const client = gatewayClient(gatewayId);
      if (!client) {
        return yield* new EgressGatewayError({
          message: `gateway ${gatewayId} was not yielded in this Worker`,
          gateway: gatewayId,
        });
      }
      minted[gatewayId] = yield* client.mint(gatewayRefs, options.ttl ?? Duration.minutes(5));
    }
    return { routes: yield* routesFor(refs, minted), minted };
  });

//#endregion
