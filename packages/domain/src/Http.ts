import * as Effect from "effect/Effect";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as OpenApi from "effect/http-api/OpenApi";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";
import type * as Layer from "effect/Layer";
import type * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import type * as Scope from "effect/Scope";
import { type Describable, describe, type Operation } from "./ApiCatalog.ts";

/**
 * The names `include` accepts for one entry: the entry's name (all its
 * request/response calls) or one call (`<name>.<operation>`). Live reads
 * (`watch`, `events`) are streams, so they are not among them.
 */
type CallsOf<E> = E extends { readonly kind: "Command"; readonly tag: infer N extends string }
  ? N
  : E extends { readonly kind: "View"; readonly viewName: infer N extends string }
    ? N | `${N}.get` | `${N}.list`
    : E extends { readonly kind: "Stream"; readonly streamName: infer N extends string }
      ? N | `${N}.peek` | `${N}.list`
      : E extends { readonly kind: "Aggregate"; readonly aggregateName: infer N extends string }
        ? N | `${N}.get`
        : never;

/**
 * What {@link toHttpApi} reads from an Api class: its catalog, and its
 * in-process client (`testClient`), which runs every call through the Api's
 * own handlers and middleware.
 */
export interface Publishable extends Describable {
  readonly testClient: Effect.Effect<unknown, never, any>;
}

/** The entries and calls of an Api that {@link toHttpApi} can publish. */
export type Includable<A extends Publishable> = CallsOf<A["entries"][number]>;

/**
 * What serving the HTTP API needs: the hosted model and the Layers of the
 * middleware its entries declare, as for the Api itself.
 */
export type Requirements<A extends Publishable> = Exclude<
  Effect.Services<A["testClient"]>,
  Scope.Scope
>;

/** The options of {@link toHttpApi}. */
export interface Options<A extends Publishable> {
  /**
   * What to publish: an entry's name publishes all its request/response
   * calls, and `"<name>.<operation>"` (`"Balance.get"`) publishes one. Nothing
   * else is served. A published path is public: plan to keep it.
   */
  readonly include: ReadonlyArray<Includable<A>>;
  /**
   * The HTTP status of each typed failure, by `_tag`, such as
   * `{ NotOwner: 403 }`. A failure not listed here answers with its
   * `httpApiStatus` annotation if its schema has one, and with 422 if not.
   */
  readonly status?: Readonly<Record<string, number>>;
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

/** The query of a `get` or `peek`: wait for a write, given as its receipt's `stream` and `version`. */
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

/** The `_tag` a failure schema admits, if it is a tagged struct or class. */
const tagOf = (schema: Schema.Top): string | undefined => {
  const encoded = SchemaAST.toEncoded(schema.ast);
  if (!SchemaAST.isObjects(encoded)) return undefined;
  const tag = encoded.propertySignatures.find((property) => property.name === "_tag")?.type;
  return tag && SchemaAST.isLiteral(tag) ? String(tag.literal) : undefined;
};

const resolveStatus = SchemaAST.resolveAt<number>("httpApiStatus");

/** Every typed failure of a call: its declared rejections, then its middleware's errors. */
const failuresOf = (rpc: Rpc.AnyWithProps): ReadonlyArray<Schema.Top> => {
  const seen = new Set<Schema.Top>();
  for (const schema of [rpc.errorSchema, ...[...rpc.middlewares].map((m) => m.error)]) {
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
    const send = client[operation.entry] as (
      payload: unknown,
      options: object,
    ) => Effect.Effect<unknown, unknown>;
    return send(request.payload, { headers });
  }
  const reads = client[operation.entry] as Record<
    string,
    (key: string, options: object) => Effect.Effect<unknown, unknown>
  >;
  const { stream, version, ...rest } = request.query ?? {};
  const atLeast =
    stream === undefined
      ? {}
      : { atLeast: { stream: stream as string, version: version as number } };
  return reads[operation.operation]!(request.params!.key, { headers, ...atLeast, ...rest });
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
      ? HttpApiEndpoint.post(operation.rpc, `/${operation.entry}`, {
          payload: rpc.payloadSchema,
          success: rpc.successSchema,
          error,
        })
      : operation.operation === "list"
        ? HttpApiEndpoint.get(operation.rpc, `/${operation.entry}/:key/list`, {
            params: { key: fields.key! },
            query: { order: fields.order!, take: fields.take!, after: fields.after! },
            success: rpc.successSchema,
            error,
          })
        : HttpApiEndpoint.get(operation.rpc, `/${operation.entry}/:key`, {
            params: { key: fields.key! },
            // A view's `get` and a stream's `peek` can wait for a write; an aggregate reads its state.
            ...(fields.atLeast ? { query: AtLeastQuery } : {}),
            success: rpc.successSchema,
            error,
          });
  const described =
    operation.description === undefined
      ? endpoint
      : endpoint.annotate(OpenApi.Description, operation.description);
  return described as unknown as HttpApiEndpoint.Top;
};

/**
 * Publish an Api's request/response calls as a plain HTTP JSON API, with an
 * OpenAPI document, from the same Api. Each published call is one endpoint:
 *
 * | Call                    | Method and path              | Input                                   |
 * | ----------------------- | ---------------------------- | --------------------------------------- |
 * | a command               | `POST /<Command>`            | JSON body: `target`, `commandId`, input |
 * | `get`, `peek`           | `GET /<Entry>/{key}`         | `?stream=&version=` waits for a write   |
 * | `list`                  | `GET /<Entry>/{key}/list`    | `?order=&take=&after=`                  |
 *
 * A command answers with its receipt; a read with what the Api's own client
 * gets (`null` for an empty key). A typed failure answers with its `_tag`
 * and data, at the status `status` gives it, else its `httpApiStatus`
 * annotation, else 422. Input its schema refuses is a 400.
 *
 * Every call goes through the Api's own handlers in process, with the HTTP
 * request's headers, so its middleware, its checks and its rejections run as
 * for any client, and its input is decoded once. Live reads (`watch`,
 * `events`) are streams and stay on the Api's own protocol. A read's `where`
 * filter is not published.
 *
 * Only the calls in `include` are published: a public path has to stay once
 * a client calls it, so nothing is published by default.
 *
 * **Example:** Serve two calls, with their OpenAPI document
 * ```typescript
 * import * as DomainHttp from "@alchemy.run/domain/Http";
 * import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
 * import * as OpenApi from "effect/http-api/OpenApi";
 *
 * const BankHttp = DomainHttp.toHttpApi(CustomerApi, {
 *   include: ["DepositMoney", "AccountSummary.get"],
 *   status: { NotOwner: 403 },
 * });
 * const BankHttpLive = HttpApiBuilder.layer(BankHttp.api, { openapiPath: "/openapi.json" }).pipe(
 *   Layer.provide(BankHttp.layer),
 *   Layer.provide(BankLive),
 * );
 * const spec = OpenApi.fromApi(BankHttp.api);
 * ```
 */
export const toHttpApi = <A extends Publishable>(
  api: A,
  options: Options<A>,
): HttpApiSurface<A["apiName"], Requirements<A>> => {
  const name = api.apiName;
  const catalog = describe(api);
  const calls = catalog.operations.filter((operation) => !operation.stream);
  // Follow-up once `expose` lands (#2585): default `include` to the entries
  // whose `exposureOf(entry).http` is true.
  const included = new Set<string>();
  for (const wanted of options.include as ReadonlyArray<string>) {
    const matched = calls.filter(
      (operation) => operation.entry === wanted || operation.rpc === wanted,
    );
    if (matched.length === 0) {
      const streamed = catalog.operations.some((operation) => operation.rpc === wanted);
      throw new Error(
        streamed
          ? `${name} cannot publish ${wanted} over HTTP: it is a stream`
          : `${name} has no entry or request/response call named ${wanted}`,
      );
    }
    for (const operation of matched) included.add(operation.rpc);
  }

  // A status for a tag no call can fail with is a typo.
  const tags = new Set<string | undefined>();
  for (const operation of catalog.operations) {
    const rpc = api.group.requests.get(operation.rpc) as Rpc.AnyWithProps;
    for (const failure of failuresOf(rpc)) tags.add(tagOf(failure));
  }
  for (const tag of Object.keys(options.status ?? {})) {
    if (!tags.has(tag)) throw new Error(`${name} has no typed failure named ${tag}`);
  }
  const withStatus = (failure: Schema.Top): Schema.Top => {
    const tag = tagOf(failure);
    const status =
      (tag === undefined ? undefined : options.status?.[tag]) ??
      resolveStatus(failure.ast) ??
      DEFAULT_STATUS;
    return HttpApiSchema.status(status)(failure);
  };

  const published: Array<Published> = [];
  let group = HttpApiGroup.make(name) as unknown as HttpApiGroup.HttpApiGroup<
    string,
    HttpApiEndpoint.Top
  >;
  for (const operation of calls) {
    if (!included.has(operation.rpc)) continue;
    const rpc = api.group.requests.get(operation.rpc) as Rpc.AnyWithProps;
    const errors = failuresOf(rpc).map(withStatus);
    const endpoint = endpointOf(operation, rpc, errors);
    const declared = errors.length === 0 ? undefined : Schema.is(Schema.Union(errors));
    published.push({ operation, isDeclared: (error) => declared?.(error) ?? false });
    group = group.add(endpoint) as typeof group;
  }

  const layerFor = (httpApi: HttpApi.HttpApi<string, HttpApiGroup.Constraint>) => {
    if (!(name in httpApi.groups)) {
      throw new Error(`${httpApi.identifier} does not hold the ${name} group: add it first`);
    }
    return HttpApiBuilder.group(httpApi as never, name as never, (handlers: any) => {
      for (const { operation, isDeclared } of published) {
        handlers = handlers.handle(operation.rpc, (request: DecodedRequest) =>
          Effect.gen(function* () {
            // The Api's in-process client: its handlers and middleware, nothing
            // serialized. One per request, as `yield* Api` builds one server per request.
            const client = (yield* api.testClient) as Client;
            return yield* call(client, operation, request);
          }).pipe(
            // Only the endpoint's declared failures are public; anything else is a defect.
            Effect.catchIf(
              (error) => !isDeclared(error),
              (error) => Effect.die(error),
            ),
            Effect.scoped,
          ),
        );
      }
      return handlers;
    });
  };

  const httpApi = HttpApi.make(name).add(group as never);
  return {
    group,
    api: httpApi,
    layer: layerFor(httpApi as never),
    layerFor,
  } as unknown as HttpApiSurface<A["apiName"], Requirements<A>>;
};
