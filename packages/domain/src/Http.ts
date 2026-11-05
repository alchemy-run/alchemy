import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as OpenApi from "effect/http-api/OpenApi";
import * as HttpEffect from "effect/http/HttpEffect";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as RpcSchema from "effect/rpc/RpcSchema";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type { Annotations } from "./Annotations.ts";
import type { Servable } from "./Api.ts";
import { DefinitionError, MissingGroup } from "./DefinitionError.ts";
import {
  type CallName,
  type ClientOf,
  exposedOf,
  type Operation,
  operationsOf,
  outsideClient,
} from "./ReadRpcs.ts";

/**
 * What {@link toHttpApi} reads from an Api class: what it serves, its RPCs,
 * and its in-process client (`clientInProcess`), which runs every call
 * through the Api's own handlers and middleware.
 */
export interface Publishable {
  readonly apiName: string;
  readonly annotations: Annotations;
  readonly serves: ReadonlyArray<Servable>;
  readonly group: RpcGroup.RpcGroup<Rpc.Any>;
  readonly clientInProcess: Effect.Effect<unknown, never, any>;
}

/**
 * What serving the HTTP API needs: the hosted model and the Layers of the
 * middleware what the Api serves declares, as for the Api itself. Not the
 * client half of any middleware: the HTTP caller sends its own headers.
 */
export type Requirements<A extends Publishable> = Exclude<
  Effect.Services<A["clientInProcess"]>,
  Scope.Scope | RpcMiddleware.ForClient<any>
>;

/**
 * A call {@link toHttpApi} can publish: a command's tag (`DepositMoney`), or a
 * read as `<Name>.<operation>` (`AccountSummary.get`, `AccountSummary.watch`).
 */
export type Exposable<A extends Publishable> = CallName<ClientOf<A>>;

/** What {@link toHttpApi} publishes. */
export interface HttpApiOptions<A extends Publishable> {
  /**
   * The calls to publish, by name. Nothing is published unless it is listed,
   * so a call the Api later adds, or a field a reply later gains, is never
   * public by accident: list each call on purpose.
   * @default []
   */
  readonly expose?: ReadonlyArray<Exposable<A>>;
}

/** The group, an HttpApi holding only it, and the Layers that serve it. */
export interface HttpApiSurface<Name extends string, R> {
  /** One endpoint per published call. Add it to your own `HttpApi` to serve it with other groups. */
  readonly group: HttpApiGroup.HttpApiGroup<Name, HttpApiEndpoint.Top>;
  /** An `HttpApi` with only {@link group}, for `HttpApiBuilder.layer` and `OpenApi.fromApi`. */
  readonly api: HttpApi.HttpApi<Name, HttpApiGroup.HttpApiGroup<Name, HttpApiEndpoint.Top>>;
  /** The handlers of {@link group} in {@link api}. */
  readonly layer: Layer.Layer<HttpApiGroup.Service<Name, Name>, never, R>;
  /**
   * The handlers of {@link group} in your own `HttpApi`, which may add a
   * prefix, middleware or other groups.
   */
  readonly layerFor: <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
    api: HttpApi.HttpApi<ApiId, Groups>,
  ) => Layer.Layer<HttpApiGroup.Service<ApiId, Name>, never, R>;
}

/** The status of a typed failure that does not declare one. */
const DEFAULT_STATUS = 422;

/** The query of a `get`, `peek` or `snapshot`: wait for a write, given as its receipt's `stream` and `version`. */
const AtLeastQuery = Schema.Struct({
  stream: Schema.optional(Schema.String),
  version: Schema.optional(Schema.Number),
}).check(
  Schema.makeFilter((query) =>
    (query.stream === undefined) === (query.version === undefined)
      ? undefined
      : "stream and version go together",
  ),
);

/** The members of a schema of failures, without `Never`. */
const membersOf = (schema: Schema.Top): ReadonlyArray<Schema.Top> => {
  const union = schema as Schema.Top & { readonly members?: ReadonlyArray<Schema.Top> };
  if (SchemaAST.isUnion(schema.ast) && union.members) return union.members.flatMap(membersOf);
  return SchemaAST.isNever(schema.ast) ? [] : [schema];
};

/**
 * The status `HttpApiSchema.status` gave a schema. It is an annotation on the
 * schema, or on its key context when the schema is a field.
 */
const resolveStatus = (ast: SchemaAST.AST): number | undefined =>
  SchemaAST.resolveAt<number>("httpApiStatus")(ast) ??
  (ast.context?.annotations?.httpApiStatus as number | undefined);

/**
 * Every typed failure of a call: its declared rejections (a streaming call
 * declares them on its stream), then its middleware's errors.
 */
const failuresOf = (rpc: Rpc.AnyWithProps): ReadonlyArray<Schema.Top> => {
  const seen = new Set<Schema.Top>();
  const streamed = RpcSchema.isStreamSchema(rpc.successSchema) ? [rpc.successSchema.error] : [];
  for (const schema of [
    rpc.errorSchema,
    ...streamed,
    ...[...rpc.middlewares].map((m) => m.error),
  ]) {
    for (const member of membersOf(schema)) seen.add(member);
  }
  return [...seen];
};

/** One published call, with what its handler needs. */
interface Published {
  readonly operation: Operation;
  /** True for the typed failures the endpoint declares; anything else is a defect. */
  readonly isDeclared: (error: unknown) => boolean;
}

/** The request a handler receives, loosely: the endpoint's decoded parts. */
interface DecodedRequest {
  readonly params?: { readonly key: string };
  readonly query?: Record<string, unknown>;
  readonly payload?: Record<string, unknown>;
  readonly request: HttpServerRequest;
}

type Client = Record<string, unknown>;

/** Call the Api's own client as the published call: the HTTP request's parts become its payload. */
const call = (client: Client, operation: Operation, request: DecodedRequest) => {
  // The request's headers go to the call, so its middleware reads cookies and tokens as usual.
  const headers = request.request.headers;
  if (operation.operation === "send") {
    const send = client[operation.name] as (
      target: unknown,
      input: unknown,
      options: object,
    ) => Effect.Effect<unknown, unknown>;
    const { target, input, commandId } = request.payload as {
      readonly target: unknown;
      readonly input: unknown;
      readonly commandId?: string;
    };
    return send(target, input, { headers, ...(commandId === undefined ? {} : { commandId }) });
  }
  if (operation.operation === "ask") {
    const ask = client[operation.name] as (
      input: unknown,
      options: object,
    ) => Effect.Effect<unknown, unknown>;
    const { input, ...options } = request.payload as { readonly input: unknown };
    return ask(input, { headers, ...options });
  }
  const reads = client[operation.name] as Record<
    string,
    (
      key: string,
      options: object,
    ) => Effect.Effect<unknown, unknown> | Stream.Stream<unknown, unknown>
  >;
  const { stream, version, ...rest } = request.query ?? {};
  const atLeast =
    stream === undefined
      ? {}
      : { atLeast: { stream: stream as string, version: version as number } };
  return reads[operation.operation]!(request.params!.key, { headers, ...atLeast, ...rest });
};

/**
 * A live read as an SSE body. The first value is read before the response
 * starts, so a failure of the read's middleware or `validate` answers with
 * its HTTP status, like any other call. A failure after that ends the stream
 * with a typed failure event. The in-process client lives until the stream
 * ends.
 */
const live = Effect.fn(function* (
  client: Effect.Effect<Client, never, Scope.Scope>,
  operation: Operation,
  request: DecodedRequest,
) {
  const scope = yield* Scope.make();
  const peeled = yield* Effect.gen(function* () {
    const reads = call(yield* client, operation, request) as Stream.Stream<unknown, unknown>;
    return yield* Stream.peel(reads, Sink.take(1));
  }).pipe(
    Scope.provide(scope),
    Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
  );
  const [first, rest] = peeled;
  return Stream.fromIterable(first).pipe(
    Stream.concat(rest),
    Stream.onExit((exit) => Scope.close(scope, exit)),
  );
});

/**
 * An answer is for one caller (middleware reads its session, a query's
 * handler scopes its rows) and is stale after the next write, so by
 * default no cache may keep it, shared or private.
 */
const NO_STORE = "private, no-store";

/**
 * The `cache-control` of a call's responses: its declaration's
 * `httpApiCacheControl` on a successful answer from a query or a read that
 * answers once, `private, no-store` on everything else.
 */
const cacheControlOf = (operation: Operation): HttpEffect.PreResponseHandler => {
  const annotated =
    operation.operation === "send" || operation.stream
      ? undefined
      : operation.served.annotations.httpApiCacheControl;
  return (_request, response) =>
    Effect.succeed(
      HttpServerResponse.setHeader(
        response,
        "cache-control",
        annotated !== undefined && response.status < 300 ? annotated : NO_STORE,
      ),
    );
};

/** A call that answers once, through a client that lives for the request. */
const once = Effect.fn(function* (
  client: Effect.Effect<Client, never, Scope.Scope>,
  operation: Operation,
  request: DecodedRequest,
) {
  return yield* call(yield* client, operation, request) as Effect.Effect<unknown, unknown>;
});

/**
 * The SSE body of a live read: each value the RPC streams is one event's
 * `data`, and a failure after the first value is the typed failure event.
 */
const sseOf = (rpc: Rpc.AnyWithProps, errors: ReadonlyArray<Schema.Top>) => {
  const streamed = rpc.successSchema as RpcSchema.Stream<Schema.Top, Schema.Top>;
  return HttpApiSchema.StreamSse({
    data: streamed.success,
    error: errors.length === 0 ? Schema.Never : Schema.Union(errors),
  });
};

/** The endpoint of one call. The schemas are the RPC's own, so the HTTP wire is the RPC wire. */
const endpointOf = (
  operation: Operation,
  rpc: Rpc.AnyWithProps,
  errors: ReadonlyArray<Schema.Top>,
): HttpApiEndpoint.Top => {
  const fields = (rpc.payloadSchema as unknown as Schema.Struct<Schema.Struct.Fields>).fields;
  const error = errors.length === 0 ? undefined : errors;
  const endpoint =
    operation.operation === "send"
      ? HttpApiEndpoint.post(operation.rpc._tag, `/${operation.name}`, {
          payload: rpc.payloadSchema,
          success: rpc.successSchema,
          error,
        })
      : // A query's input is any schema, so it goes in a JSON body. QUERY is
        // the safe, idempotent method that carries one.
        operation.operation === "ask"
        ? HttpApiEndpoint.query(operation.rpc._tag, `/${operation.name}`, {
            payload: rpc.payloadSchema,
            success: rpc.successSchema,
            error,
          })
        : operation.stream
          ? HttpApiEndpoint.get(
              operation.rpc._tag,
              `/${operation.name}/:key/${operation.operation}`,
              {
                params: { key: fields.key! },
                // `events` resumes after a cursor; `watch` takes nothing but the key.
                ...(fields.after ? { query: { after: fields.after } } : {}),
                success: sseOf(rpc, errors),
                error,
              },
            )
          : operation.operation === "list"
            ? HttpApiEndpoint.get(operation.rpc._tag, `/${operation.name}/:key/list`, {
                params: { key: fields.key! },
                query: {
                  order: fields.order!,
                  take: fields.take!,
                  after: fields.after!,
                },
                success: rpc.successSchema,
                error,
              })
            : HttpApiEndpoint.get(
                operation.rpc._tag,
                operation.operation === "snapshot"
                  ? `/${operation.name}/:key/snapshot`
                  : `/${operation.name}/:key`,
                {
                  params: { key: fields.key! },
                  // A view's reads and a stream's `peek` can wait for a write.
                  ...(fields.atLeast ? { query: AtLeastQuery } : {}),
                  success: rpc.successSchema,
                  error,
                },
              );
  // The entry's description, for the OpenAPI document.
  const described =
    operation.description === undefined
      ? endpoint
      : (endpoint as unknown as HttpApiEndpoint.Top).annotate(
          OpenApi.Description,
          operation.description,
        );
  return described as unknown as HttpApiEndpoint.Top;
};

/**
 * Publish an Api's calls as a plain HTTP JSON API, with an OpenAPI document,
 * from the same Api. Each published call is one endpoint:
 *
 * | Call          | Method and path              | Input                                          |
 * | ------------- | ---------------------------- | ---------------------------------------------- |
 * | a command     | `POST /<Command>`            | JSON body: `target`, `commandId`, input        |
 * | a query       | `QUERY /<Query>`             | JSON body: `input`, `atLeast`, `after`, `take` |
 * | `get`, `peek` | `GET /<Name>/{key}`          | `?stream=&version=` waits for a write          |
 * | `snapshot`    | `GET /<Name>/{key}/snapshot` | `?stream=&version=` waits for a write          |
 * | `list`        | `GET /<Name>/{key}/list`     | `?order=&take=&after=`                         |
 * | `watch`       | `GET /<Name>/{key}/watch`    | Server-Sent Events                             |
 * | `events`      | `GET /<Name>/{key}/events`   | Server-Sent Events, `?after=` a cursor         |
 *
 * A command answers with its receipt; a query with its result (a paged one
 * with `{ entries, cursor }`); a read with what the Api's own client gets
 * (`null` for an empty key). A typed failure answers with its `_tag`
 * and data, at the status its schema's `httpApiStatus` annotation gives it
 * (`Domain.Rejection("NotOwner", {}, { httpApiStatus: 403 })`), and 422 if it
 * has none: a rejection is a refused request, not a server fault. Input its
 * schema refuses is a 400.
 *
 * A live read (`watch`, `events`) answers with a Server-Sent Events stream:
 * each value is one event's JSON `data`. A failure before the first value,
 * such as its middleware refusing the caller, answers with its status like
 * any other call. A failure after it, such as `validate` refusing a change,
 * ends the stream with an `effect/http-api/stream/failure` event whose
 * `data` is the typed failure.
 *
 * Every response carries `cache-control: private, no-store`: it is for one
 * caller, and stale after the next write. A query's or a read's declaration
 * can loosen that for its successful answers with the `httpApiCacheControl`
 * annotation (`{ httpApiCacheControl: "public, max-age=60" }`).
 *
 * Every call goes through the Api's own handlers in process, with the HTTP
 * request's headers, so its middleware, its checks and its rejections run as
 * for any client, and its input is decoded once. A read's `where` filter is
 * not published.
 *
 * Nothing is published by default: `expose` lists each call to publish, so
 * what an Api serves its own clients never reaches HTTP by accident. It is
 * convenient for internal tools. A public or partner API is better written
 * as its own `HttpApi`, with response schemas of its own, that calls the
 * Api in process.
 *
 * **Example:** Serve an Api, with its OpenAPI document
 * ```typescript
 * import * as DomainHttp from "@alchemy.run/domain/Http";
 * import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
 * import * as OpenApi from "effect/http-api/OpenApi";
 *
 * const BankHttp = DomainHttp.toHttpApi(CustomerApi, {
 *   expose: ["DepositMoney", "AccountSummary.get", "AccountSummary.watch"],
 * });
 * const BankHttpLive = HttpApiBuilder.layer(BankHttp.api, { openapiPath: "/openapi.json" }).pipe(
 *   Layer.provide(BankHttp.layer),
 *   Layer.provide(BankLive),
 * );
 * const spec = OpenApi.fromApi(BankHttp.api);
 * ```
 *
 * **Example:** Watch a view from a browser
 * ```typescript
 * // in the browser: one event per change, each `{ state, cursor }`
 * const source = new EventSource(`/AccountSummary/${accountId}/watch`);
 * source.onmessage = (event) => render(JSON.parse(event.data).state);
 * ```
 */
export const toHttpApi = <A extends Publishable>(
  api: A,
  options: HttpApiOptions<A> = {},
): HttpApiSurface<A["apiName"], Requirements<A>> => {
  const name = api.apiName;
  const calls = exposedOf(operationsOf(api.serves), options.expose);
  // A failure without a status of its own is a refused request, not a server fault.
  const withStatus = (failure: Schema.Top): Schema.Top =>
    resolveStatus(failure.ast) === undefined
      ? HttpApiSchema.status(DEFAULT_STATUS)(failure)
      : failure;

  const published: Array<Published> = [];
  let group = HttpApiGroup.make(name) as unknown as HttpApiGroup.HttpApiGroup<
    string,
    HttpApiEndpoint.Top
  >;
  for (const operation of calls) {
    const { rpc } = operation;
    const errors = failuresOf(rpc).map(withStatus);
    const endpoint = endpointOf(operation, rpc, errors);
    const declared = errors.length === 0 ? undefined : Schema.is(Schema.Union(errors));
    published.push({ operation, isDeclared: (error) => declared?.(error) ?? false });
    group = group.add(endpoint) as typeof group;
  }

  const layerFor = (httpApi: HttpApi.HttpApi<string, HttpApiGroup.Constraint>) => {
    if (!(name in httpApi.groups)) {
      return new DefinitionError({
        reason: new MissingGroup({ httpApi: httpApi.identifier, group: name }),
      }).pipe(Effect.die, Layer.effectDiscard);
    }
    return HttpApiBuilder.group(httpApi as never, name as never, (handlers: any) => {
      // The Api's in-process client: its handlers and middleware, nothing
      // serialized. One per request, as `yield* Api` builds one server per request.
      // Without the client half of any middleware (see `outsideClient`).
      const client = outsideClient(api) as Effect.Effect<Client, never, Scope.Scope>;
      for (const { operation, isDeclared } of published) {
        // Only the endpoint's declared failures are public; anything else is a defect.
        const declaredOnly = <A, R>(effect: Effect.Effect<A, unknown, R>) =>
          Effect.catchIf(effect, (error) => !isDeclared(error), Effect.die);
        const cacheControl = cacheControlOf(operation);
        handlers = handlers.handle(operation.rpc._tag, (request: DecodedRequest) =>
          (operation.stream
            ? live(client, operation, request).pipe(
                declaredOnly,
                Effect.map(Stream.catchIf((error) => !isDeclared(error), Stream.die)),
              )
            : once(client, operation, request).pipe(declaredOnly, Effect.scoped)
          ).pipe(HttpEffect.withPreResponseHandler(cacheControl)),
        );
      }
      return handlers;
    });
  };

  // The Api's description describes its group and the OpenAPI document.
  const { description } = api.annotations;
  if (description !== undefined) group = group.annotate(OpenApi.Description, description);
  const made = HttpApi.make(name).add(group as never);
  const httpApi =
    description === undefined ? made : made.annotate(OpenApi.Description, description);
  return {
    group,
    api: httpApi,
    layer: layerFor(httpApi as never),
    layerFor,
  } as unknown as HttpApiSurface<A["apiName"], Requirements<A>>;
};
