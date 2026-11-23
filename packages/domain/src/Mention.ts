/**
 * A model's commands, views, streams and queries as things an `AI.Process`
 * can mention, and what turns one of an Api's calls into a tool.
 *
 * Nothing here imports `@alchemy.run/ai`: a mention is an object with a
 * well-known key, and what a session acts as is a service read by its key.
 *
 * @module
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as Scope from "effect/Scope";
import * as Api from "./Api.ts";
import { sendPayload } from "./internal.ts";
import type * as Model from "./Model.ts";
import { type Operation, operationsOf, outsideClient } from "./ReadRpcs.ts";
import * as RequestContext from "./RequestContext.ts";

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

/** Characters every MCP client and model provider accepts in a tool name. */
const unsafe = /[^A-Za-z0-9_-]/g;
/**
 * The tool's name: `<api>_<name>_<operation>`, with any other character
 * than a letter, digit, `_` or `-` replaced by `_`.
 */
export const toolName = (op: {
  readonly api: string;
  readonly name: string;
  readonly operation: string;
}): string => `${op.api}_${op.name}_${op.operation}`.replace(unsafe, "_");

/**
 * What the model reads about the tool: a command's `description`, or a
 * sentence for the call; a read follows its sentence with its entry's
 * `description` (`Get the current AccountSummary of a key. An account's
 * balance and owner.`).
 */
export const toolDescription = (op: Operation): string => {
  if (op.operation === "send") return op.description ?? `Send the ${op.name} command.`;
  const call =
    op.operation === "ask"
      ? op.served.kind === "Query" && op.served.definition.paged
        ? `Ask the ${op.name} query for a page of entries.`
        : `Ask the ${op.name} query.`
      : op.operation === "peek"
        ? `Get the latest entry of the ${op.name} stream for a key.`
        : op.operation === "list"
          ? `List a page of the ${op.name} entries of a key.`
          : op.operation === "snapshot"
            ? `Get the current ${op.name} of a key, with the cursor it is valid at.`
            : `Get the current ${op.name} of a key.`;
  return op.description === undefined ? call : `${call} ${op.description}`;
};

/**
 * A call that returns once. A stream (`watch`, `events`) is not one tool
 * result: it stays on the Api's own clients.
 */
export const isToolCall = (op: Operation): boolean => !op.stream;

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

export type Client = Record<string, unknown>;

/**
 * Send one call through the Api's client: a command takes its input
 * and command id; a query its input and options; a read its key and options.
 */
export const invoke = (
  client: Client,
  op: Operation,
  payload: unknown,
  headers?: Headers.Input,
) => {
  if (op.operation === "send") {
    return sendPayload(client[op.name], payload, { headers });
  }
  if (op.operation === "ask") {
    const ask = client[op.name] as (input: unknown, o: object) => Effect.Effect<unknown, unknown>;
    const { input, ...options } = payload as { readonly input: unknown };
    return ask(input, { ...options, headers });
  }
  const { key, ...options } = payload as { readonly key: unknown };
  const read = (
    client[op.name] as Record<string, (k: unknown, o: object) => Effect.Effect<unknown, unknown>>
  )[op.operation]!;
  return read(key, { ...options, headers });
};

/** One call's name, what a model is told of it, and whether its result is wrapped. */
export const specOf = (api: string, op: Operation) => {
  const { rpc } = op;
  const success = rpc.successSchema;
  // MCP clients reject a tool whose output is not an object (`State | null`),
  // so such a value is returned as `{ value }`.
  const wrapped = !isObject(success);
  return {
    name: toolName({ api, name: op.name, operation: op.operation }),
    wrapped,
    spec: {
      description: toolDescription(op),
      // JSON codecs, as the Api's HTTP server uses: the tool decodes the
      // call's JSON once, and the in-process call does not decode it again.
      parameters: Schema.toCodecJson(rpc.payloadSchema),
      success: Schema.toCodecJson(wrapped ? Schema.Struct({ value: success }) : success),
      failure: Schema.toCodecJson(
        failures([rpc.errorSchema, ...[...rpc.middlewares].map((middleware) => middleware.error)]),
      ),
    },
  };
};

/**
 * The tool call a process's harness is answering (`AI.ToolCall`), read by
 * its key so this package needs nothing of `@alchemy.run/ai`.
 */
class ToolCall extends Context.Service<
  ToolCall,
  { readonly conversationId: string; readonly callId: string }
>()("AI.ToolCall") {}

/** What the session of the tool call acts as (`AI.Acting`), as it was stored at its start. */
class Acting extends Context.Service<Acting, { readonly as: RequestContext.Json }>()("AI.Acting") {}

/** The header a session's call carries what it acts as under. Only this module's own client sets it. */
const ACTING = "x-alchemy-acting";

/**
 * A command's parameters as a model is given them: its input and when to
 * answer. The command's id is not the model's to choose.
 */
const withoutCommandId = (payload: Schema.Top): Schema.Top => {
  const { commandId: _, ...fields } = (payload as unknown as Schema.Struct<Schema.Struct.Fields>)
    .fields;
  return Schema.toCodecJson(Schema.Struct(fields));
};

/** What a mention reads of the Api made for it. */
interface Surface {
  readonly apiName: string;
  readonly serves: Parameters<typeof operationsOf>[0];
  readonly group: Parameters<typeof outsideClient>[0]["group"];
  readonly clientInProcess: Effect.Effect<unknown, never, any>;
}

/** Which of a model's entries a mention gives, by name. */
export interface Entries {
  readonly commands?: ReadonlyArray<string>;
  readonly views?: ReadonlyArray<string>;
  readonly streams?: ReadonlyArray<string>;
  readonly queries?: ReadonlyArray<string>;
}

/** The one read of a view or stream a mention gives: its state now, or its latest entry. */
const READS = new Set(["get", "peek"]);

/**
 * Something an `AI.Process` can mention: its name in the prose, the tools
 * mentioning it gives, and how what a session acts as is stored. `R` is
 * what running the process then requires, and `As` what a session must be
 * started as.
 */
export interface Mention<R = never, As = never> {
  readonly "~alchemy/AI/Mention": {
    readonly name: string;
    readonly tools: Effect.Effect<ReadonlyArray<never>, never, R>;
    readonly as: (context: Context.Context<never>) => Effect.Effect<RequestContext.Json>;
  };
  /** Phantom: what a session of a process that mentions this must be started as. */
  readonly "~as"?: As;
}

/**
 * Some of a model's entries as a mention. Each call is a tool named
 * `<model>_<name>_<operation>`, with the call's own schemas; a rejection
 * comes back to the model as the tool's failure.
 *
 * A call runs the middleware of what it calls, as an Api's server does.
 * A middleware with a Layer where the process runs is run with it. One
 * without, which only says who is calling, is answered by what the session
 * acts as: the request context it was started with is provided in its
 * place. A command is sent under the id of the tool call that asked for
 * it, so the model never chooses a command's id.
 *
 * @internal
 */
export const of = (model: Model.Any, entries: Entries): Mention<unknown, unknown> => {
  // The entries as an Api of their own: its server runs each call's middleware.
  let made: { readonly api: Surface; readonly operations: ReadonlyArray<Operation> } | undefined;
  const surface = () =>
    (made ??= (() => {
      const api = Api.make(model.modelName, {
        model,
        commands: entries.commands ?? [],
        views: entries.views ?? [],
        streams: entries.streams ?? [],
        queries: entries.queries ?? [],
      } as never) as unknown as Surface;
      const operations = operationsOf(api.serves).filter(
        (op) =>
          isToolCall(op) &&
          (op.operation === "send" || op.operation === "ask" || READS.has(op.operation)),
      );
      return { api, operations };
    })());
  return {
    "~alchemy/AI/Mention": {
      get name() {
        const { api, operations } = surface();
        return operations.map((op) => `\`${specOf(api.apiName, op).name}\``).join(", ");
      },
      as: (context) => RequestContext.capture.pipe(Effect.provideContext(context)),
      tools: Effect.gen(function* () {
        const { api, operations } = surface();
        const context = yield* Effect.context<never>();
        // A middleware nobody provided here says who is calling: what the
        // session acts as answers it.
        const answered = [
          ...new Set(
            operations.flatMap((op) => [...op.rpc.middlewares] as Array<RpcMiddleware.AnyService>),
          ),
        ].filter((middleware) => Option.isNone(Context.getOption(context, middleware)));
        const acting = Layer.mergeAll(
          Layer.empty,
          ...answered.map((middleware) =>
            Layer.succeed(middleware, ((
              effect: Effect.Effect<unknown>,
              { headers }: { readonly headers: Headers.Headers },
            ) =>
              Effect.flatMap(
                RequestContext.restore(JSON.parse(headers[ACTING] ?? "{}")),
                (context) => Effect.provideContext(effect, context),
              )) as never),
          ),
        );
        // The client lives as long as the process's host: nothing closes it.
        let client: Promise<Client> | undefined;
        const clientOf = Effect.promise(
          () =>
            (client ??= Effect.runPromiseWith(context)(
              Effect.flatMap(Scope.make(), (scope) =>
                (outsideClient(api) as Effect.Effect<Client>).pipe(
                  Effect.provide(acting),
                  Effect.provideService(Scope.Scope, scope),
                ),
              ),
            )),
        );
        return operations.map((op) => {
          const { name, spec, wrapped } = specOf(api.apiName, op);
          const command = op.operation === "send";
          return {
            "~alchemy/AI/Tool": "inline",
            toolName: name,
            spec: command ? { ...spec, parameters: withoutCommandId(op.rpc.payloadSchema) } : spec,
            handler: (payload: unknown) =>
              Effect.gen(function* () {
                const call = Option.getOrUndefined(yield* Effect.serviceOption(ToolCall));
                const session = Option.getOrUndefined(yield* Effect.serviceOption(Acting));
                // The command's id is the tool call's, so a call that is run
                // again after a crash sends the command once, and two calls
                // never share one.
                const sent =
                  command && call !== undefined
                    ? { ...(payload as object), commandId: `${call.conversationId}:${call.callId}` }
                    : payload;
                const value = yield* invoke(yield* clientOf, op, sent, {
                  [ACTING]: JSON.stringify(session?.as ?? {}),
                });
                return wrapped ? { value } : value;
              }).pipe(Effect.provideContext(context)),
          };
        }) as unknown as ReadonlyArray<never>;
      }),
    },
  };
};
