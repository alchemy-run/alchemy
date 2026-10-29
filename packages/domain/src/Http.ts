import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSchema from "effect/rpc/RpcSchema";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type { Entry } from "./Api.ts";
import { DefinitionError } from "./internal.ts";
import { nameOf, readRpcs, type ReadRpcs } from "./ReadRpcs.ts";

/**
 * The names `include` accepts for one entry: the entry's name (all its
 * calls) or one call (`<name>.<operation>`).
 */
type CallsOf<E> = E extends { readonly kind: "Command"; readonly tag: infer N extends string }
  ? N
  : E extends { readonly kind: "View"; readonly viewName: infer N extends string }
    ? N | `${N}.${"get" | "watch" | "events" | "list" | "snapshot"}`
    : E extends { readonly kind: "Stream"; readonly streamName: infer N extends string }
      ? N | `${N}.${"peek" | "watch" | "events" | "list"}`
      : E extends { readonly kind: "Aggregate"; readonly aggregateName: infer N extends string }
        ? N | `${N}.${"get" | "watch" | "events"}`
        : never;

/**
 * What {@link toHttpApi} reads from an Api class: its entries, the RPCs it
 * serves, and its in-process client (`clientInProcess`), which runs every
 * call through the Api's own handlers and middleware.
 */
export interface Publishable {
  readonly apiName: string;
  readonly entries: ReadonlyArray<Entry>;
  readonly group: RpcGroup.RpcGroup<Rpc.Any>;
  readonly clientInProcess: Effect.Effect<unknown, never, any>;
}

/** One call an Api serves: the entry it belongs to, the client method, and its RPC tag. */
interface Operation {
  /** A command's tag, or a view's, stream's or aggregate's name. */
  readonly entry: string;
  /** `send` for a command; the read's client method otherwise (`get`, `peek`, `watch`, ...). */
  readonly operation: string;
  /** The RPC tag the server answers to (`Deposit`, `Balance.get`). */
  readonly rpc: string;
  /** Whether the call answers with a stream of values (`watch`, `events`). */
  readonly stream: boolean;
}

/** Every call an Api serves, in the order it lists its entries. */
const operationsOf = (api: Publishable): ReadonlyArray<Operation> =>
  api.entries.flatMap((entry): ReadonlyArray<Operation> => {
    if (entry.kind === "Command") {
      return [{ entry: entry.tag, operation: "send", rpc: entry.rpc._tag, stream: false }];
    }
    const name = nameOf(entry);
    return Object.entries(readRpcs(entry)).flatMap(([call, rpc]) => {
      if (rpc === undefined) return [];
      // The group's RPC also carries middleware applied to the whole Api.
      const served = (api.group.requests.get(rpc._tag) ?? rpc) as Rpc.AnyWithProps;
      // A stream's `get` RPC is its client's `peek`.
      const operation =
        (call as keyof ReadRpcs) === "get" && entry.kind === "Stream" ? "peek" : call;
      return [
        {
          entry: name,
          operation,
          rpc: served._tag,
          stream: RpcSchema.isStreamSchema(served.successSchema),
        },
      ];
    });
  });

/** The entries and calls of an Api that {@link toHttpApi} can publish. */
export type Includable<A extends Publishable> = CallsOf<A["entries"][number]>;

/**
 * What serving the HTTP API needs: the hosted model and the Layers of the
 * middleware its entries declare, as for the Api itself.
 */
export type Requirements<A extends Publishable> = Exclude<
  Effect.Services<A["clientInProcess"]>,
  Scope.Scope
>;

/** The options of {@link toHttpApi}. */
export interface Options<A extends Publishable> {
  /**
   * What to publish: an entry's name publishes all its calls, and
   * `"<name>.<operation>"` (`"Balance.get"`) publishes one. Nothing else is
   * served. A published path is public: plan to keep it. A name the Api
   * cannot serve is a type error, and the Layer dies with a `DefinitionError`.
   */
  readonly include: ReadonlyArray<Includable<A>>;
  /**
   * The HTTP status of each typed failure, by `_tag`, such as
   * `{ NotOwner: 403 }`. A failure not listed here answers with its
   * `httpApiStatus` annotation if its schema has one, and with 422 if not.
   * A tag no published call can fail with is a typo: the Layer dies with a
   * `DefinitionError`.
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

/** The `_tag` a failure schema admits, if it is a tagged struct or class. */
const tagOf = (schema: Schema.Top): string | undefined => {
  const encoded = SchemaAST.toEncoded(schema.ast);
  if (!SchemaAST.isObjects(encoded)) return undefined;
  const tag = encoded.propertySignatures.find((property) => property.name === "_tag")?.type;
  return tag && SchemaAST.isLiteral(tag) ? String(tag.literal) : undefined;
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
    const send = client[operation.entry] as (
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
  const reads = client[operation.entry] as Record<
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
      ? HttpApiEndpoint.post(operation.rpc, `/${operation.entry}`, {
          payload: rpc.payloadSchema,
          success: rpc.successSchema,
          error,
        })
      : operation.stream
        ? HttpApiEndpoint.get(operation.rpc, `/${operation.entry}/:key/${operation.operation}`, {
            params: { key: fields.key! },
            // `events` resumes after a cursor; `watch` takes nothing but the key.
            ...(fields.after ? { query: { after: fields.after } } : {}),
            success: sseOf(rpc, errors),
            error,
          })
        : operation.operation === "list"
          ? HttpApiEndpoint.get(operation.rpc, `/${operation.entry}/:key/list`, {
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
              operation.rpc,
              operation.operation === "snapshot"
                ? `/${operation.entry}/:key/snapshot`
                : `/${operation.entry}/:key`,
              {
                params: { key: fields.key! },
                // A view's reads and a stream's `peek` can wait for a write; an aggregate reads its state.
                ...(fields.atLeast ? { query: AtLeastQuery } : {}),
                success: rpc.successSchema,
                error,
              },
            );
  return endpoint as unknown as HttpApiEndpoint.Top;
};

/**
 * Publish an Api's calls as a plain HTTP JSON API, with an OpenAPI document,
 * from the same Api. Each published call is one endpoint:
 *
 * | Call                    | Method and path              | Input                                   |
 * | ----------------------- | ---------------------------- | --------------------------------------- |
 * | a command               | `POST /<Command>`            | JSON body: `target`, `commandId`, input |
 * | `get`, `peek`           | `GET /<Entry>/{key}`         | `?stream=&version=` waits for a write   |
 * | `snapshot`              | `GET /<Entry>/{key}/snapshot`| `?stream=&version=` waits for a write   |
 * | `list`                  | `GET /<Entry>/{key}/list`    | `?order=&take=&after=`                  |
 * | `watch`                 | `GET /<Entry>/{key}/watch`   | Server-Sent Events                      |
 * | `events`                | `GET /<Entry>/{key}/events`  | Server-Sent Events, `?after=` a cursor  |
 *
 * A command answers with its receipt; a read with what the Api's own client
 * gets (`null` for an empty key). A typed failure answers with its `_tag`
 * and data, at the status `status` gives it, else its `httpApiStatus`
 * annotation, else 422. Input its schema refuses is a 400.
 *
 * A live read (`watch`, `events`) answers with a Server-Sent Events stream:
 * each value is one event's JSON `data`. A failure before the first value,
 * such as its middleware refusing the caller, answers with its status like
 * any other call. A failure after it, such as `validate` refusing a change,
 * ends the stream with an `effect/http-api/stream/failure` event whose
 * `data` is the typed failure.
 *
 * Every call goes through the Api's own handlers in process, with the HTTP
 * request's headers, so its middleware, its checks and its rejections run as
 * for any client, and its input is decoded once. A read's `where` filter is
 * not published.
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
 *
 * **Example:** Watch a view from a browser
 * ```typescript
 * const BankHttp = DomainHttp.toHttpApi(CustomerApi, {
 *   include: ["AccountSummary.watch"],
 * });
 *
 * // in the browser: one event per change, each `{ state, cursor }`
 * const source = new EventSource(`/AccountSummary/${accountId}/watch`);
 * source.onmessage = (event) => render(JSON.parse(event.data).state);
 * ```
 */
export const toHttpApi = <A extends Publishable>(
  api: A,
  options: Options<A>,
): HttpApiSurface<A["apiName"], Requirements<A>> => {
  const name = api.apiName;
  const calls = operationsOf(api);
  // Follow-up once `expose` lands (#2585): default `include` to the entries
  // whose `exposureOf(entry).http` is true.
  // A name the Api cannot serve fails the Layer, like the model's own definition problems.
  const problems: Array<DefinitionError> = [];
  const included = new Set<string>();
  for (const wanted of options.include as ReadonlyArray<string>) {
    const matched = calls.filter(
      (operation) => operation.entry === wanted || operation.rpc === wanted,
    );
    if (matched.length === 0) {
      problems.push(new DefinitionError(`${name} has no entry or call named ${wanted}`));
    }
    for (const operation of matched) included.add(operation.rpc);
  }

  // A status for a tag no call can fail with is a typo.
  const tags = new Set<string | undefined>();
  for (const operation of calls) {
    const rpc = api.group.requests.get(operation.rpc) as Rpc.AnyWithProps;
    for (const failure of failuresOf(rpc)) tags.add(tagOf(failure));
  }
  for (const tag of Object.keys(options.status ?? {})) {
    if (!tags.has(tag))
      problems.push(new DefinitionError(`${name} has no typed failure named ${tag}`));
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
    const problem =
      problems[0] ??
      (name in httpApi.groups
        ? undefined
        : new DefinitionError(
            `${httpApi.identifier} does not hold the ${name} group: add it first`,
          ));
    if (problem) return Layer.effectDiscard(Effect.die(problem));
    return HttpApiBuilder.group(httpApi as never, name as never, (handlers: any) => {
      // The Api's in-process client: its handlers and middleware, nothing
      // serialized. One per request, as `yield* Api` builds one server per request.
      const client = api.clientInProcess as Effect.Effect<Client, never, Scope.Scope>;
      for (const { operation, isDeclared } of published) {
        // Only the endpoint's declared failures are public; anything else is a defect.
        const declaredOnly = <A, R>(effect: Effect.Effect<A, unknown, R>) =>
          Effect.catchIf(effect, (error) => !isDeclared(error), Effect.die);
        handlers = handlers.handle(operation.rpc, (request: DecodedRequest) =>
          operation.stream
            ? live(client, operation, request).pipe(
                declaredOnly,
                Effect.map(Stream.catchIf((error) => !isDeclared(error), Stream.die)),
              )
            : once(client, operation, request).pipe(declaredOnly, Effect.scoped),
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
