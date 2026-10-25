import type * as JsonSchema from "effect/JsonSchema";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSchema from "effect/rpc/RpcSchema";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import type { Entry } from "./Api.ts";
import { nameOf, readRpcs } from "./ReadRpcs.ts";

/** A JSON Schema (draft 2020-12), self-contained: its definitions are under `$defs`. */
export const JsonSchemaObject = Schema.Record(Schema.String, Schema.Json);

/** The kinds of entry an Api can expose. */
export const EntryKind = Schema.Literals(["Command", "View", "Aggregate", "Stream"]);
export type EntryKind = typeof EntryKind.Type;

/**
 * The call a client makes: `send` for a command; `get`, `watch` and `events`
 * for a view or an aggregate, and `list` for a view; a stream has `peek`,
 * `watch`, `events` and `list`.
 */
export const OperationName = Schema.Literals(["send", "get", "peek", "watch", "events", "list"]);
export type OperationName = typeof OperationName.Type;

/**
 * One call an Api serves. The schemas describe the JSON on the wire (the
 * encoded side of each schema), which is what a non-Effect caller sends and
 * receives.
 */
export const Operation = Schema.Struct({
  /** The Api's name. */
  api: Schema.String,
  /** The entry's name: a command's tag, or a view's, aggregate's or stream's name. */
  entry: Schema.String,
  kind: EntryKind,
  operation: OperationName,
  /** The RPC tag the server answers to (`Deposit`, `Balance.get`). */
  rpc: Schema.String,
  /** A command writes; every other call reads. */
  mode: Schema.Literals(["read", "write"]),
  /** Whether the call answers with a stream of values (`watch`, `events`). */
  stream: Schema.Boolean,
  /** The payload: a command's `target`, `commandId` and input; a read's `key` and options. */
  input: JsonSchemaObject,
  /** What the call returns, or each value a streaming call emits. */
  success: JsonSchemaObject,
  /**
   * Every typed failure: the declared rejections and the errors of the
   * middleware that guards the call. `{ "not": {} }` when it cannot fail typed.
   */
  error: JsonSchemaObject,
  /** The entry's `description` annotation, if it has one. */
  description: Schema.optionalKey(Schema.String),
});
export type Operation = typeof Operation.Type;

/** What an Api serves, one {@link Operation} per call. */
export const Catalog = Schema.Struct({
  api: Schema.String,
  operations: Schema.Array(Operation),
});
export type Catalog = typeof Catalog.Type;

/** What {@link describe} reads from an Api class. */
export interface Describable {
  readonly apiName: string;
  readonly entries: ReadonlyArray<Entry>;
  readonly group: RpcGroup.RpcGroup<Rpc.Any>;
}

/** How an entry is called: its name, whether it writes, and its RPC per operation. */
interface Surface {
  readonly name: string;
  readonly mode: "read" | "write";
  readonly calls: ReadonlyArray<{ readonly operation: OperationName; readonly rpc: Rpc.Any }>;
}

/** The calls of each kind of entry. A new kind of entry adds its case here. */
const surfaceOf = (entry: Entry): Surface => {
  switch (entry.kind) {
    case "Command":
      return { name: entry.tag, mode: "write", calls: [{ operation: "send", rpc: entry.rpc }] };
    case "View":
    case "Aggregate":
    case "Stream": {
      const name = nameOf(entry);
      return {
        name,
        mode: "read",
        calls: Object.values(readRpcs(entry)).map((rpc) => ({
          // Read RPCs are tagged `<name>.<operation>`.
          operation: rpc._tag.slice(name.length + 1) as OperationName,
          rpc,
        })),
      };
    }
  }
};

/** One schema for several failures, without repeats or `Never`. @internal */
export const failures = (schemas: ReadonlyArray<Schema.Top>): Schema.Top => {
  const members = new Set<Schema.Top>();
  for (const schema of schemas) {
    const union = schema as Schema.Top & { readonly members?: ReadonlyArray<Schema.Top> };
    for (const member of SchemaAST.isUnion(schema.ast) && union.members
      ? union.members
      : [schema]) {
      if (!SchemaAST.isNever(member.ast)) members.add(member);
    }
  }
  const list = [...members];
  return list.length === 0 ? Schema.Never : list.length === 1 ? list[0]! : Schema.Union(list);
};

/** A self-contained JSON Schema: definitions move under `$defs`, as `effect/ai` tools do. */
const toJsonSchema = (schema: Schema.Top): JsonSchema.JsonSchema => {
  const document = Schema.toJsonSchemaDocument(schema);
  return Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions };
};

const descriptionOf = (entry: Entry): string | undefined =>
  Schema.isSchema(entry) ? SchemaAST.resolveDescription(entry.ast) : undefined;

/**
 * A machine-readable catalog of an Api: one record per call it serves, with
 * the JSON Schemas of its input, its success and its typed failures. It is
 * read from the same RPCs the server answers, so it cannot drift from them.
 * The result is plain JSON, in the order the Api lists its entries, and the
 * same on every call, so a test can snapshot it to catch a breaking change.
 *
 * **Example:** List the calls of an Api
 * ```typescript
 * const catalog = Domain.Api.describe(CustomerApi);
 * for (const op of catalog.operations) {
 *   console.log(op.rpc, op.mode, op.stream ? "stream" : "call");
 * }
 * ```
 */
export const describe = (api: Describable): Catalog => ({
  api: api.apiName,
  operations: api.entries.flatMap((entry) => {
    const { name, mode, calls } = surfaceOf(entry);
    const description = descriptionOf(entry);
    return calls.map(({ operation, rpc }): Operation => {
      // The group's RPC also carries middleware applied to the whole Api.
      const served = (api.group.requests.get(rpc._tag) ?? rpc) as Rpc.AnyWithProps;
      const streamed = RpcSchema.isStreamSchema(served.successSchema)
        ? served.successSchema
        : undefined;
      return {
        api: api.apiName,
        entry: name,
        kind: entry.kind,
        operation,
        rpc: served._tag,
        mode,
        stream: streamed !== undefined,
        input: toJsonSchema(served.payloadSchema) as Operation["input"],
        success: toJsonSchema(streamed?.success ?? served.successSchema) as Operation["success"],
        error: toJsonSchema(
          failures([
            served.errorSchema,
            ...(streamed ? [streamed.error] : []),
            ...[...served.middlewares].map((middleware) => middleware.error),
          ]),
        ) as Operation["error"],
        ...(description === undefined ? {} : { description }),
      };
    });
  }),
});
