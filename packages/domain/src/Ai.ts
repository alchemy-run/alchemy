import { McpServer, Tool, Toolkit } from "effect/ai";
import * as Effect from "effect/Effect";
import type * as Headers from "effect/http/Headers";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSchema from "effect/rpc/RpcSchema";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import type * as Scope from "effect/Scope";
import type { Entry } from "./Api.ts";
import { DefinitionError } from "./internal.ts";
import { nameOf, readRpcs, type ReadRpcs } from "./ReadRpcs.ts";

/** What {@link toToolkit} reads from an Api class: its entries, the RPCs it serves, and its in-process client. */
export interface Toolable {
  readonly apiName: string;
  readonly entries: ReadonlyArray<Entry>;
  readonly group: RpcGroup.RpcGroup<Rpc.Any>;
  readonly clientInProcess: Effect.Effect<unknown, never, any>;
}

/** The services an Api's tools need: the hosted Domain and its middleware Layers. */
export type Services<A extends Toolable> = Exclude<
  Effect.Services<A["clientInProcess"]>,
  Scope.Scope
>;

/** One call an Api serves. */
interface Operation {
  readonly api: string;
  /** The entry it belongs to: a command's tag, or a view's, stream's or aggregate's name. */
  readonly entry: Entry;
  readonly name: string;
  /** `send` for a command; the read's client method otherwise (`get`, `peek`, `list`, ...). */
  readonly operation: string;
  /** The RPC the server answers, with middleware applied to the whole Api. */
  readonly rpc: Rpc.AnyWithProps;
  readonly stream: boolean;
}

/** Every call an Api serves, in the order it lists its entries. */
const operationsOf = (api: Toolable): ReadonlyArray<Operation> =>
  api.entries.flatMap((entry): ReadonlyArray<Operation> => {
    const served = (rpc: Rpc.Any) => (api.group.requests.get(rpc._tag) ?? rpc) as Rpc.AnyWithProps;
    if (entry.kind === "Command") {
      const rpc = served(entry.rpc);
      return [{ api: api.apiName, entry, name: entry.tag, operation: "send", rpc, stream: false }];
    }
    const name = nameOf(entry);
    return Object.entries(readRpcs(entry)).flatMap(([call, read]) => {
      if (read === undefined) return [];
      const rpc = served(read);
      // A stream's `get` RPC is its client's `peek`.
      const operation =
        (call as keyof ReadRpcs) === "get" && entry.kind === "Stream" ? "peek" : call;
      const stream = RpcSchema.isStreamSchema(rpc.successSchema);
      return [{ api: api.apiName, entry, name, operation, rpc, stream }];
    });
  });

/** One schema for several failures, without repeats or `Never`. */
const failures = (schemas: ReadonlyArray<Schema.Top>): Schema.Top => {
  const members = new Set<Schema.Top>();
  const add = (schema: Schema.Top): void => {
    const union = schema as Schema.Top & { readonly members?: ReadonlyArray<Schema.Top> };
    if (SchemaAST.isUnion(schema.ast) && union.members) union.members.forEach(add);
    else if (!SchemaAST.isNever(schema.ast)) members.add(schema);
  };
  schemas.forEach(add);
  const list = [...members];
  return list.length === 0 ? Schema.Never : list.length === 1 ? list[0]! : Schema.Union(list);
};

export interface ToolkitOptions<R = never> {
  /**
   * The headers each call carries to the Api's middleware (a session cookie,
   * a bearer token), read in the context of the call. By default, the
   * headers of the current `HttpServerRequest`, if there is one: an MCP
   * server over HTTP passes on what its client sent. Without one, a call
   * carries no headers.
   */
  readonly headers?: Effect.Effect<Headers.Input, never, R>;
}

/** An Api's tools, and the Layer that answers them. */
export interface ApiToolkit<R> {
  /** One tool per call of the Api that returns once (see {@link toToolkit}). */
  readonly toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>;
  /** The handlers of {@link toolkit}: each calls the Api in process. */
  readonly layer: Layer.Layer<Tool.HandlersFor<Record<string, Tool.Any>>, never, R>;
}

/** Characters every MCP client and model provider accepts in a tool name. */
const unsafe = /[^A-Za-z0-9_-]/g;
/** The longest tool name model providers accept. */
const MAX_NAME = 64;

/**
 * The tool's name: `<api>_<entry>_<operation>`, with any other character
 * than a letter, digit, `_` or `-` replaced by `_`.
 */
export const toolName = (op: {
  readonly api: string;
  readonly entry: string;
  readonly operation: string;
}): string => `${op.api}_${op.entry}_${op.operation}`.replace(unsafe, "_");

/**
 * What the model reads about the tool: a command's Schema `description`
 * annotation, or a sentence built from the call. Entry `examples` (#2581)
 * will add here.
 */
const toolDescription = (op: Operation): string =>
  (op.entry.kind === "Command" ? SchemaAST.resolveDescription(op.entry.ast) : undefined) ??
  (op.operation === "send"
    ? `Send the ${op.name} command.`
    : op.operation === "peek"
      ? `Get the latest entry of the ${op.name} stream for a key.`
      : op.operation === "list"
        ? `List a page of the ${op.name} entries of a key.`
        : op.operation === "snapshot"
          ? `Get the current ${op.name} of a key, with the cursor it is valid at.`
          : `Get the current ${op.name} of a key.`);

/**
 * Whether an agent may see the entry. Every entry, until entries declare
 * where they are published (#2585: `Domain.exposureOf(entry).mcp`).
 */
const isExposed = (_entry: Entry): boolean => true;

/**
 * Whether a person must confirm a call first. Never, until commands declare
 * it (#2585: `(call) => Domain.needsApproval(entry, call)`).
 */
const approvalOf = (_entry: Entry): Tool.NeedsApproval<Schema.Top> | undefined => undefined;

/**
 * A call that returns once. A stream (`watch`, `events`) is not one tool
 * result: it stays on the Api's own clients.
 */
const isToolCall = (op: Operation): boolean => !op.stream;

/** Whether values of the schema are JSON objects, as an MCP tool's output must be. */
const isObject = (schema: Schema.Top): boolean => {
  const document = Schema.toJsonSchemaDocument(schema);
  const ref = document.schema.$ref;
  const root =
    typeof ref === "string"
      ? (document.definitions[ref.slice(ref.lastIndexOf("/") + 1)] ?? document.schema)
      : document.schema;
  return root.type === "object";
};

/** The tool for one call, and how to call it with the in-process client. */
const toolOf = (op: Operation) => {
  const { rpc } = op;
  const success = rpc.successSchema;
  // MCP clients reject a tool whose output is not an object (`State | null`),
  // so such a value is returned as `{ value }`.
  const wrapped = !isObject(success);
  const write = op.operation === "send";
  const tool = Tool.make(toolName({ api: op.api, entry: op.name, operation: op.operation }), {
    description: toolDescription(op),
    // JSON codecs, as the Api's HTTP server uses: the tool decodes the
    // call's JSON once, and the in-process call does not decode it again.
    parameters: Schema.toCodecJson(rpc.payloadSchema),
    success: Schema.toCodecJson(wrapped ? Schema.Struct({ value: success }) : success),
    failure: Schema.toCodecJson(
      failures([rpc.errorSchema, ...[...rpc.middlewares].map((middleware) => middleware.error)]),
    ),
    // A rejection is a result the model can act on, not a failed generation.
    failureMode: "return",
    needsApproval: approvalOf(op.entry),
  })
    .annotate(Tool.Readonly, !write)
    .annotate(Tool.Destructive, write)
    .annotate(Tool.Idempotent, !write);
  return { tool, op, wrapped };
};

type Client = Record<string, unknown>;

/**
 * Send one call through the Api's client: a command takes its target, input
 * and command id; a read its key and options.
 */
const invoke = (client: Client, op: Operation, payload: unknown, headers?: Headers.Input) => {
  if (op.operation === "send") {
    const send = client[op.name] as (
      target: unknown,
      input: unknown,
      options: object,
    ) => Effect.Effect<unknown, unknown>;
    const { target, input, commandId } = payload as {
      readonly target: unknown;
      readonly input: unknown;
      readonly commandId?: string;
    };
    return send(target, input, { headers, ...(commandId === undefined ? {} : { commandId }) });
  }
  const { key, ...options } = payload as { readonly key: unknown };
  const read = (
    client[op.name] as Record<string, (k: unknown, o: object) => Effect.Effect<unknown, unknown>>
  )[op.operation]!;
  return read(key, { ...options, headers });
};

const requestHeaders: Effect.Effect<Headers.Input | undefined> = Effect.map(
  Effect.serviceOption(HttpServerRequest),
  Option.match({ onNone: () => undefined, onSome: (request) => request.headers }),
);

/**
 * An Effect AI `Toolkit` with one tool per call of the Api that returns once:
 * each command's `send` (a write), and each `get`, `peek`, `list` and
 * `snapshot` (reads).
 * `watch` and `events` are streams, not one tool result, so they stay on the
 * Api's own clients.
 *
 * A tool is named `<api>_<entry>_<operation>` (`BankApi_DepositMoney_send`),
 * with every character other than a letter, digit, `_` or `-` replaced by
 * `_`. Its parameters, success and failure are the call's own schemas, as the
 * Api's RPC server decodes them. A read is marked
 * read-only and a command destructive. A success that is not a JSON object
 * (a view's `state | null`) comes back as `{ value }`, since MCP requires an
 * object.
 *
 * Each handler calls the Api in process, through the same RPC server as
 * `clientInProcess`: the call's middleware runs against the headers from
 * `options.headers`, and a rejection or a middleware error comes back as the
 * tool's typed failure, for the model to act on. Any other error is a
 * defect, and never reaches the model. Two calls that make the same tool
 * name, or a name longer than 64 characters, fail the Layer with a
 * `DefinitionError`.
 *
 * **Example:** Tools for an in-app agent
 * ```typescript
 * import * as DomainAi from "@alchemy.run/domain/Ai";
 * import { LanguageModel } from "effect/ai";
 *
 * const { toolkit, layer } = DomainAi.toToolkit(CustomerApi, {
 *   // The signed-in customer's session, for the Api's session middleware.
 *   headers: Effect.map(CurrentSession, (s) => ({ authorization: `Bearer ${s.token}` })),
 * });
 *
 * const answer = LanguageModel.generateText({
 *   prompt: "Move 20 dollars to savings",
 *   toolkit,
 * }).pipe(Effect.provide(layer));
 * ```
 */
export const toToolkit = <A extends Toolable, R = never>(
  api: A,
  options: ToolkitOptions<R> = {},
): ApiToolkit<Services<A> | R> => {
  // A tool name a model provider would refuse fails the Layer, like the model's own definition problems.
  const problems: Array<DefinitionError> = [];
  const names = new Set<string>();
  const tools = operationsOf(api)
    .filter((op) => isToolCall(op) && isExposed(op.entry))
    .map(toolOf)
    .filter(({ tool }) => {
      if (tool.name.length > MAX_NAME) {
        problems.push(
          new DefinitionError(`The tool name ${tool.name} is longer than ${MAX_NAME} characters`),
        );
      } else if (names.has(tool.name)) {
        problems.push(
          new DefinitionError(`Two calls of ${api.apiName} make the tool ${tool.name}`),
        );
      } else {
        names.add(tool.name);
        return true;
      }
      return false;
    });
  const toolkit = Toolkit.make(...tools.map(({ tool }) => tool)) as unknown as Toolkit.Toolkit<
    Record<string, Tool.Any>
  >;
  const headers = (options.headers ?? requestHeaders) as Effect.Effect<
    Headers.Input | undefined,
    never,
    R
  >;
  const layer = toolkit.toLayer(
    Effect.gen(function* () {
      if (problems.length > 0) return yield* Effect.die(problems[0]);
      const client = (yield* api.clientInProcess) as Client;
      return Object.fromEntries(
        tools.map(({ tool, op, wrapped }) => [
          tool.name,
          (payload: unknown) =>
            headers.pipe(
              Effect.flatMap((headers) => invoke(client, op, payload, headers)),
              Effect.map((value) => (wrapped ? { value } : value)),
            ),
        ]),
      );
    }) as Effect.Effect<Record<string, never>, never, Services<A> | R | Scope.Scope>,
  );
  return { toolkit, layer } as ApiToolkit<Services<A> | R>;
};

/**
 * Serve an Api's tools ({@link toToolkit}) from Effect's `McpServer`. Provide
 * an `McpServer` transport, such as `McpServer.layerHttp`. Over HTTP, each
 * call carries the headers of the MCP request to the Api's middleware, so
 * the Api authenticates an MCP client as it does any other.
 *
 * **Example:** An MCP server for an Api
 * ```typescript
 * import * as DomainAi from "@alchemy.run/domain/Ai";
 * import { McpProtocol, McpServer } from "effect/ai";
 * import * as HttpRouter from "effect/http/HttpRouter";
 *
 * const Mcp = DomainAi.toMcp(CustomerApi).pipe(
 *   Layer.provide(
 *     McpServer.layerHttp({
 *       name: "bank",
 *       version: "1.0.0",
 *       path: "/mcp",
 *       protocols: [McpProtocol.v2025_11_25],
 *     }),
 *   ),
 *   Layer.provide(BankLive),
 * );
 *
 * const { handler } = HttpRouter.toWebHandler(Mcp);
 * ```
 */
export const toMcp = <A extends Toolable, R = never>(
  api: A,
  options: ToolkitOptions<R> = {},
): Layer.Layer<never, never, Services<A> | R> => {
  const { toolkit, layer } = toToolkit(api, options);
  return McpServer.toolkit(toolkit).pipe(Layer.provide(layer)) as Layer.Layer<
    never,
    never,
    Services<A> | R
  >;
};
