/**
 * Routes as classes with pluggable implementations.
 *
 * Effect's `HttpApi` keys implementations by group: `HttpApiBuilder.group`
 * yields one `HttpApiGroup.Service` per group, and every endpoint of the
 * group is implemented in that one call. A route here is an
 * `HttpApiEndpoint` that also carries the tag of its implementation, so one
 * route can have many implementations, each a `Layer`, and the group is
 * mounted once from the tags.
 *
 * ```typescript
 * export class GetRepo extends Http.get<GetRepo>()("get", "/repos/:owner/:repo", {
 *   params: RepoPath,
 *   success: Repo,
 *   error: [RepoNotFound, Unauthorized],
 *   middleware: [Authenticated],
 * }) {}
 *
 * export const GetRepoLive = GetRepo.make(
 *   Effect.gen(function* () {
 *     const repos = yield* Repos;                 // build time: bindings
 *     return Effect.fn(function* ({ params }) {  // request time
 *       const { principal } = yield* Caller;
 *       return yield* repos.get(principal, params.owner, params.repo);
 *     });
 *   }),
 * );
 * ```
 *
 * The route is an endpoint, so it goes into any `HttpApiGroup`, which goes
 * into any `HttpApi`, and the client, OpenAPI, and middleware come from
 * Effect unchanged. {@link handlers} mounts every route group of an API
 * under that API's middleware and requires the route tags, so the compiler
 * names any route left unimplemented.
 */
import { RuntimeContext } from "../RuntimeContext.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import type { HttpMethod } from "effect/unstable/http/HttpMethod";
import type { HttpServerError } from "effect/unstable/http/HttpServerError";
import type * as HttpRouter from "effect/unstable/http/HttpRouter";
import type * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import type * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import type * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import type * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

// ─────────────────────────────────────────────────────────────────────────────
// The tag on the endpoint
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The endpoint annotation carrying a route's implementation tag. Annotations
 * survive `.middleware()` and `.prefix()`, which copy the endpoint, so a
 * route stays a route however the API that mounts it is derived.
 */
export class RouteTag extends Context.Service<
  RouteTag,
  Context.Key<any, any>
>()("alchemy/Http/RouteTag") {}

/**
 * A route's request handler: the decoded request in, the declared success
 * (or a raw `HttpServerResponse`) out. It may fail with the route's declared
 * errors and its middleware's, and it may use what the router provides per
 * request, what the route's middleware provides, and the runtime.
 */
export type Handler<Route extends HttpApiEndpoint.Constraint> =
  HttpApiEndpoint.Handler<
    Route,
    HttpApiEndpoint.MiddlewareError<Route> | HttpServerError,
    | HttpRouter.Provided
    | HttpApiEndpoint.MiddlewareProvides<Route>
    | RuntimeContext
  >;

/** What a route class adds to its endpoint. */
export interface RouteStatics<
  Self,
  Endpoint extends HttpApiEndpoint.Constraint,
> {
  readonly "~Route": Self;
  /** The implementation tag; {@link handlers} resolves it at build time. */
  readonly Tag: Context.Key<Self, Handler<Route<Self, Endpoint>>>;
  /**
   * An implementation of the route as a Layer. `init` runs once, when the
   * layer is built, and returns the per-request handler.
   */
  readonly make: <E, R>(
    init: Effect.Effect<Handler<Route<Self, Endpoint>>, E, R>,
  ) => Layer.Layer<Self, E, R>;
}

/** An `HttpApiEndpoint` that carries the tag of its implementation. */
export type Route<
  Self,
  Endpoint extends HttpApiEndpoint.Constraint,
> = Endpoint & RouteStatics<Self, Endpoint>;

type MiddlewareId<M> = M extends Context.Key<infer I, any> ? I : never;

type WithMiddleware<
  Endpoint,
  Middleware extends ReadonlyArray<Context.Key<HttpApiMiddleware.AnyId, any>>,
> = [Middleware[number]] extends [never]
  ? Endpoint
  : HttpApiEndpoint.AddMiddleware<
      Endpoint,
      Extract<MiddlewareId<Middleware[number]>, HttpApiMiddleware.AnyId>
    >;

// The codec overload of `HttpApiEndpoint.make` maps the option schemas to
// their wire codecs. Replicated here because an instantiation expression
// over the overloaded builder is checked against every overload's
// constraints, and the codec-free overload rejects non-string schemas.
type UnwrapReadonlyArray<S> = S extends ReadonlyArray<infer A> ? A : S;

type ExtractBufferedSuccess<S extends HttpApiEndpoint.SuccessConstraint> =
  Exclude<
    Extract<UnwrapReadonlyArray<S>, Schema.Top>,
    | HttpApiSchema.StreamSchema
    | HttpApiSchema.WithHeaders<Schema.Top, Schema.Top>
  >;

type ExtractStreamSuccess<S extends HttpApiEndpoint.SuccessConstraint> =
  UnwrapReadonlyArray<S> extends infer Success
    ? Success extends HttpApiSchema.StreamSchema
      ? Success
      : never
    : never;

type ExtractWithHeadersSuccess<S extends HttpApiEndpoint.SuccessConstraint> =
  UnwrapReadonlyArray<S> extends infer Success
    ? Success extends HttpApiSchema.WithHeaders<infer _Inner, infer _Headers>
      ? HttpApiSchema.WithHeaders<
          _Inner extends HttpApiSchema.StreamSchema
            ? _Inner
            : Schema.toCodecJson<_Inner>,
          Schema.toCodecStringTree<_Headers>
        >
      : never
    : never;

type ToSuccessCodec<S extends HttpApiEndpoint.SuccessConstraint> = [
  ExtractBufferedSuccess<S>,
] extends [never]
  ? ExtractStreamSuccess<S> | ExtractWithHeadersSuccess<S>
  :
      | Schema.toCodecJson<ExtractBufferedSuccess<S>>
      | ExtractStreamSuccess<S>
      | ExtractWithHeadersSuccess<S>;

type ToJsonCodec<S> = [S] extends [never]
  ? never
  : [S] extends [Schema.Constraint]
    ? Schema.toCodecJson<S>
    : never;

type ToStringTreeCodec<S> = [S] extends [never]
  ? never
  : [S] extends [Schema.Struct.Fields]
    ? Schema.toCodecStringTree<Schema.Struct<S>>
    : [S] extends [Schema.Constraint]
      ? Schema.toCodecStringTree<S>
      : never;

type ToSchema<
  S extends
    | Schema.Struct.Fields
    | Schema.Constraint
    | ReadonlyArray<Schema.Constraint>,
> = S extends Schema.Struct.Fields
  ? Schema.Struct<S>
  : S extends ReadonlyArray<Schema.Constraint>
    ? S[number]
    : S;

/** The endpoint `HttpApiEndpoint.make(method)(identifier, path, options)` builds. */
export type EndpointOf<
  Method extends HttpMethod,
  Identifier extends string,
  Path extends string,
  Params extends Schema.Top | Schema.Struct.Fields,
  Query extends Schema.Top | Schema.Struct.Fields,
  Payload extends HttpApiEndpoint.PayloadConstraintCodecs<Method>,
  Headers extends Schema.Top | Schema.Struct.Fields,
  Success extends HttpApiEndpoint.SuccessConstraint,
  Error extends HttpApiEndpoint.ErrorConstraint,
> = HttpApiEndpoint.HttpApiEndpoint<
  Identifier,
  Method,
  Path,
  ToStringTreeCodec<Params>,
  ToStringTreeCodec<Query>,
  Method extends HttpMethod.WithBody
    ? ToJsonCodec<ToSchema<Payload>>
    : ToStringTreeCodec<ToSchema<Payload>>,
  ToStringTreeCodec<Headers>,
  ToSuccessCodec<Success>,
  ToJsonCodec<
    Error extends ReadonlyArray<Schema.Constraint> ? Error[number] : Error
  >
>;

let sequence = 0;

/**
 * Builds the route constructor for one HTTP method: the same identifier,
 * path, and options `HttpApiEndpoint` takes, plus `middleware`, the
 * middleware the route relies on. The result is a class to extend.
 */
export const make =
  <Method extends HttpMethod>(method: Method) =>
  <Self>() =>
  <
    const Identifier extends string,
    const Path extends HttpRouter.PathInput,
    Params extends Schema.Top | Schema.Struct.Fields = never,
    Query extends Schema.Top | Schema.Struct.Fields = never,
    Payload extends HttpApiEndpoint.PayloadConstraintCodecs<Method> = never,
    Headers extends Schema.Top | Schema.Struct.Fields = never,
    const Success extends HttpApiEndpoint.SuccessConstraint =
      HttpApiSchema.NoContent,
    const Error extends HttpApiEndpoint.ErrorConstraint = never,
    const Middleware extends ReadonlyArray<
      Context.Key<HttpApiMiddleware.AnyId, any>
    > = [],
  >(
    identifier: Identifier,
    path: Path,
    options?: {
      readonly params?: Params | undefined;
      readonly query?: Query | undefined;
      readonly headers?: Headers | undefined;
      readonly payload?: Payload | undefined;
      readonly success?: Success | undefined;
      readonly error?: Error | undefined;
      /** The middleware this route relies on; what it provides is available to the handler. */
      readonly middleware?: Middleware | undefined;
    },
  ): Route<
    Self,
    WithMiddleware<
      EndpointOf<
        Method,
        Identifier,
        Path,
        Params,
        Query,
        Payload,
        Headers,
        Success,
        Error
      >,
      Middleware
    >
  > => {
    const { middleware, ...endpointOptions } = options ?? {};
    // Identifiers are unique within a group, not an API: `repos.list` and
    // `pulls.list` are different routes. The sequence keeps their tags apart.
    const Tag = Context.Service<Self, Handler<any>>(
      `alchemy/Http/Route/${method} ${identifier} #${++sequence}`,
    );
    let endpoint: HttpApiEndpoint.Top = HttpApiEndpoint.make(method)(
      identifier,
      path,
      endpointOptions as any,
    ) as unknown as HttpApiEndpoint.Top;
    for (const m of middleware ?? []) {
      endpoint = endpoint.middleware(
        m as any,
      ) as unknown as HttpApiEndpoint.Top;
    }
    endpoint = endpoint.annotate(
      RouteTag,
      Tag,
    ) as unknown as HttpApiEndpoint.Top;
    const statics = {
      Tag,
      make: (init: Effect.Effect<Handler<any>, any, any>) =>
        Layer.effect(Tag, init),
    };
    return Object.assign(endpoint, statics) as any;
  };

/** A `GET` route. */
export const get = make("GET");
/** A `POST` route. */
export const post = make("POST");
/** A `PUT` route. */
export const put = make("PUT");
/** A `PATCH` route. */
export const patch = make("PATCH");
/** A `DELETE` route. */
export const del = make("DELETE");
/** A `HEAD` route. */
export const head = make("HEAD");
/** An `OPTIONS` route. */
export const options = make("OPTIONS");

// ─────────────────────────────────────────────────────────────────────────────
// Mounting
// ─────────────────────────────────────────────────────────────────────────────

type RouteSelf<E> = E extends { readonly "~Route": infer S } ? S : never;

/** The groups of `Groups` whose every endpoint is a route. */
export type RouteGroups<Groups> = Groups extends HttpApiGroup.Constraint
  ? [HttpApiGroup.Endpoints<Groups>] extends [{ readonly "~Route": any }]
    ? Groups
    : never
  : never;

/** The implementation tags of every route in the route groups of `Groups`. */
export type Tags<Groups> = RouteSelf<
  HttpApiGroup.Endpoints<RouteGroups<Groups>>
>;

/**
 * The Layer {@link handlers} returns: the group services of every route
 * group, requiring the route tags and the middleware those routes declare.
 */
export type Handlers<
  Id extends string,
  Groups extends HttpApiGroup.Constraint,
> = Layer.Layer<
  HttpApiGroup.ToService<Id, RouteGroups<Groups>>,
  never,
  | Tags<Groups>
  | HttpApiEndpoint.Middleware<HttpApiGroup.Endpoints<RouteGroups<Groups>>>
  | HttpApiEndpoint.MiddlewareServices<
      HttpApiGroup.Endpoints<RouteGroups<Groups>>
    >
  | HttpRouter.Request.From<"Requires", RuntimeContext>
>;

const routeTag = (endpoint: HttpApiEndpoint.Top) =>
  Context.getOrUndefined(endpoint.annotations, RouteTag);

const isRouteGroup = (group: HttpApiGroup.Top) => {
  const endpoints = Object.values(
    group.endpoints,
  ) as Array<HttpApiEndpoint.Top>;
  return (
    endpoints.length > 0 &&
    endpoints.every((endpoint) => routeTag(endpoint) !== undefined)
  );
};

const mountGroup = (
  api: HttpApi.HttpApi<string, any>,
  group: HttpApiGroup.Top,
) =>
  HttpApiBuilder.group(api as any, group.identifier as never, (h: any) =>
    Effect.gen(function* () {
      let handlers = h;
      for (const endpoint of Object.values(
        group.endpoints,
      ) as Array<HttpApiEndpoint.Top>) {
        const tag = routeTag(endpoint)!;
        const impl = yield* tag;
        handlers = handlers.handle(endpoint.identifier, impl);
      }
      return handlers;
    }),
  ) as Layer.Layer<any, never, any>;

/**
 * Mounts one route group of `api` under `api`'s middleware: the ordinary
 * `HttpApiBuilder.group`, with every endpoint delegating to its route tag.
 * Built from the API rather than the group because API-level middleware is
 * pushed down into the API's copy of each group.
 */
export const group = <
  Id extends string,
  Groups extends HttpApiGroup.Constraint,
  const Identifier extends HttpApiGroup.Identifier<RouteGroups<Groups>>,
>(
  api: HttpApi.HttpApi<Id, Groups>,
  identifier: Identifier,
): Handlers<Id, HttpApiGroup.WithIdentifier<Groups, Identifier>> =>
  mountGroup(api, api.groups[identifier] as unknown as HttpApiGroup.Top) as any;

/**
 * Mounts every route group of `api`: one `HttpApiBuilder.group` per group
 * whose endpoints are all routes, requiring their tags and middleware.
 * Groups with a plain endpoint are left to you, implemented with
 * `HttpApiBuilder.group` as usual.
 *
 * ```typescript
 * HttpApiBuilder.layer(AppApi).pipe(
 *   Layer.provide(Http.handlers(AppApi)),
 *   Layer.provide([MeLive, GetUserBetterAuth]),
 *   Layer.provide(Git.Handlers),
 *   Layer.provide(AuthenticatedLive),
 *   Layer.provide(Http.Platform),
 *   HttpRouter.toHttpEffect,
 * )
 * ```
 */
export const handlers = <
  Id extends string,
  Groups extends HttpApiGroup.Constraint,
>(
  api: HttpApi.HttpApi<Id, Groups>,
): Handlers<Id, Groups> => {
  const layers = (Object.values(api.groups) as Array<HttpApiGroup.Top>)
    .filter(isRouteGroup)
    .map((group) => mountGroup(api, group));
  return (
    layers.length === 0
      ? Layer.empty
      : Layer.mergeAll(...(layers as [Layer.Layer<any, never, any>]))
  ) as any;
};
