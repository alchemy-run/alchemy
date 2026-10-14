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
import { makeRpcStub } from "../Cloudflare/Workers/Rpc.ts";
import { Worker } from "../Cloudflare/Workers/Worker.ts";
import { WorkerEnvironment } from "../Cloudflare/Workers/WorkerRuntime.ts";
import * as Output from "../Output.ts";
import { Random } from "../Random.ts";
import type { Rpc } from "../Rpc.ts";
import { RpcCallError } from "../Rpc.ts";
import { RuntimeContext, sanitizeKey } from "../RuntimeContext.ts";
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
import { type Route, routesFor, type EgressRouteConflict } from "./Route.ts";

//#region types

/** The egress kinds a gateway declares, by name. */
export type GatewayDeclaration = { readonly [name: string]: EgressKind<string, never> };

/**
 * The requirement `yield* Gateway` leaves for the stack: which host serves
 * the gateway. Provide it with `Gateway.host(worker)`.
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

/** What `Gateway.serve` returns: a Worker (or Lambda) implementation. */
export type GatewayServer = {
  /** The sandbox's traffic: `Authorization: Macaroon <grant>`, `x-alchemy-target`, `x-alchemy-method`. */
  readonly fetch: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest | Scope.Scope | RuntimeContext
  >;
  /** Sign a grant for refs to this gateway's egresses. Called over a service binding. */
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
  /** Where the sandbox's traffic goes (the HTTPS transport). */
  readonly url: Effect.Effect<string, never, RuntimeContext>;
  /** Ask the gateway to sign a grant. */
  readonly mint: (
    refs: ReadonlyArray<EgressRef>,
    ttl: Duration.Input,
  ) => Effect.Effect<MintedGrant, EgressNotServed | EgressGatewayError, RuntimeContext>;
}

/** An egress a Durable Object can grant to a sandbox. */
export interface GrantableEgress<G, E> {
  /** A value from this gateway can only be granted by it. */
  readonly gateway: GatewayClient<G>;
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
   * Which Worker serves this gateway: provide the returned Layer to the
   * stack, like a sandbox's host. The Worker's implementation must be (or
   * expose) this gateway's `serve`.
   *
   * TODO(egress): Lambda-hosted gateways. `serve` already runs on a Lambda;
   * hosting needs a Lambda branch here that binds the function URL and
   * `lambda:InvokeFunction` (mint over IAM, not the public URL, which would
   * expose `mint` through the HTTP RPC route).
   */
  host<R = never>(
    worker: Effect.Effect<Worker & Rpc<{ readonly mint: MintMethod }>, never, R>,
    options?: GatewayHostOptions,
  ): Layer.Layer<GatewayHost<Self>, never, R>;
}

//#endregion

//#region runtime client registry

/** The gateways this isolate has yielded, by id (the owning Durable Object looks them up from stored refs). */
const clients = new Map<string, GatewayClient>();

/** The client for gateway `id`, if this isolate yielded it. */
export const gatewayClient = (id: string): GatewayClient | undefined => clients.get(id);

const bindingName = (id: string) => `ALCHEMY_EGRESS_${sanitizeKey(id)}`;

const grantable = <G, E>(client: GatewayClient<G>, ref: EgressRef): GrantableEgress<G, E> => ({
  gateway: client,
  ref,
  narrow: (scope) => grantable(client, { ...ref, scope }),
  for: (subject) => grantable(client, { ...ref, subject }),
});

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
  GATEWAY_ONLY.has(name) || name.startsWith("cf-") || name.startsWith("x-forwarded-");

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

      return { fetch, mint } satisfies GatewayServer;
    });

//#endregion

interface GatewayHostShape {
  readonly worker: Effect.Effect<Worker, never, any>;
  readonly path: string;
}

const makeClient = (id: string, hostTag: Context.Key<any, GatewayHostShape>) =>
  Effect.gen(function* () {
    const name = bindingName(id);
    const urlKey = `${name}_URL`;
    const ctx = yield* RuntimeContext;
    let url: Effect.Effect<string>;
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      // Deploy: bind the gateway's Worker (a service binding, for mint) and
      // its URL (for the sandbox's traffic) into this Worker.
      const host = yield* hostTag;
      const worker = yield* host.worker;
      const self = yield* Worker;
      yield* self.bind`EgressGateway(${id})`({
        bindings: [{ type: "service", name, service: worker.workerName }],
      });
      const path = host.path;
      const publicUrl = worker.url.pipe(
        Output.map((base: string | undefined) => (base ? new URL(path, base).toString() : "")),
      ) as Output.Output<string>;
      url = (yield* Output.named(publicUrl, urlKey).asEffect()) as unknown as Effect.Effect<string>;
    } else {
      url = ctx.get<string>(sanitizeKey(urlKey)) as unknown as Effect.Effect<string>;
    }
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
    const client: GatewayClient = {
      id,
      url,
      mint: (refs, ttl) =>
        Effect.gen(function* () {
          const result = yield* stub.mint(refs, Duration.toMillis(ttl)).pipe(
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
          return { gateway: { id, url: yield* url }, ...result } satisfies MintedGrant;
        }),
    };
    clients.set(id, client);
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
      static host = (worker: Effect.Effect<Worker, never, any>, options: GatewayHostOptions = {}) =>
        Layer.succeed(hostTag, { worker, path: options.path ?? "/" });
    }
    return Object.assign(
      GatewayDeclarationClass,
      Effectable.Prototype({
        label: `Egress.Gateway<${id}>`,
        evaluate: () =>
          Effect.map(makeClient(id, hostTag), (client) =>
            Object.fromEntries(
              Object.keys(egresses).map((name) => [
                name,
                grantable(client, { gateway: id, egress: name }),
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
