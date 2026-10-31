import * as Schema from "effect/Schema";
import type * as Aggregate from "./Aggregate.ts";
import type * as Api from "./Api.ts";
import type * as Command from "./Command.ts";
import type { Fields } from "./Event.ts";
import { rejectionTag } from "./internal.ts";
import * as Key from "./Key.ts";
import type * as Middleware from "./Middleware.ts";
import type * as Model from "./Model.ts";
import type * as Rejection from "./Rejection.ts";
import type * as View from "./View.ts";

/** A JSON Schema of a value's JSON form, with the definitions it refers to. */
export interface SchemaDescription {
  readonly schema: unknown;
  readonly definitions: unknown;
}

/** A command, as data. */
export interface CommandDescription {
  readonly tag: string;
  readonly target: SchemaDescription;
  readonly input: SchemaDescription;
  /** The tags of the events it may record. */
  readonly events: ReadonlyArray<string>;
  /** The tags of the rejections it may return. */
  readonly rejects: ReadonlyArray<string>;
  /** The service keys of its middleware, in order. */
  readonly middleware: ReadonlyArray<string>;
  readonly reply?: SchemaDescription;
  /** The phases in which it may run, or `"*"`. Absent for an aggregate with no phases. */
  readonly when?: ReadonlyArray<string> | "*";
}

/** An event, or a rejection, as data. */
export interface MessageDescription {
  readonly tag: string;
  readonly schema: SchemaDescription;
}

/** One move a phase allows: this event may take an instance to these phases. */
export interface MoveDescription {
  readonly event: string;
  readonly to: ReadonlyArray<string>;
}

/** An aggregate's phase table. */
export interface PhasesDescription {
  /** The phase of the aggregate's `initial` state. */
  readonly initial: string;
  readonly phases: ReadonlyArray<{
    readonly name: string;
    readonly on: ReadonlyArray<MoveDescription>;
  }>;
}

/** An aggregate, as data. */
export interface AggregateDescription {
  readonly name: string;
  readonly id: SchemaDescription;
  readonly state: SchemaDescription;
  readonly commands: ReadonlyArray<CommandDescription>;
  readonly events: ReadonlyArray<MessageDescription>;
  readonly rejections: ReadonlyArray<MessageDescription>;
  readonly phases?: PhasesDescription;
}

/** What keys a consumer: an aggregate's name, or the JSON Schema of a key value. */
export type KeyDescription =
  | { readonly aggregate: string }
  | { readonly schema: SchemaDescription };

/** A view, as data. */
export interface ViewDescription {
  readonly name: string;
  readonly from: ReadonlyArray<string>;
  readonly key: KeyDescription;
  readonly state?: SchemaDescription;
  /** The tags of the events it emits, if it declares them. */
  readonly events?: ReadonlyArray<string>;
  readonly middleware: ReadonlyArray<string>;
  readonly rejects: ReadonlyArray<string>;
}

/**
 * A policy, as data. What it sends lives in its handler, so a description
 * can't list that.
 */
export interface PolicyDescription {
  readonly name: string;
  readonly from: ReadonlyArray<string>;
  /** Absent for a policy keyed by its source instance. */
  readonly key?: KeyDescription;
  readonly on: ReadonlyArray<string>;
}

/** A projection, as data. */
export interface ProjectionDescription {
  readonly name: string;
  readonly from: ReadonlyArray<string>;
  readonly key: KeyDescription;
  readonly on: ReadonlyArray<string>;
  /** The names of the streams it appends to. */
  readonly writes: ReadonlyArray<string>;
}

/** A stream, as data. */
export interface StreamDescription {
  readonly name: string;
  readonly key: KeyDescription;
  readonly entries: ReadonlyArray<string>;
}

/** A saga, as data. Its steps live in its workflow, so a description can't list them. */
export interface SagaDescription {
  readonly name: string;
  readonly key: SchemaDescription;
  readonly input?: SchemaDescription;
  readonly result?: SchemaDescription;
  readonly rejects: ReadonlyArray<string>;
}

/** An Api, as data. */
export interface ApiDescription {
  readonly name: string;
  readonly entries: ReadonlyArray<{ readonly kind: Api.Entry["kind"]; readonly name: string }>;
}

/**
 * A model as plain JSON data, from {@link describe}. Every list is sorted by
 * name, so the order of a declaration changes nothing.
 */
export interface Description {
  readonly name: string;
  /** A hash of everything else here: see {@link describe}. */
  readonly hash: string;
  readonly aggregates: ReadonlyArray<AggregateDescription>;
  readonly views: ReadonlyArray<ViewDescription>;
  readonly policies: ReadonlyArray<PolicyDescription>;
  readonly projections: ReadonlyArray<ProjectionDescription>;
  readonly streams: ReadonlyArray<StreamDescription>;
  readonly sagas: ReadonlyArray<SagaDescription>;
  readonly apis: ReadonlyArray<ApiDescription>;
}

/** Options for {@link describe}. */
export interface DescribeOptions {
  /** The Apis to include. A model does not know the Apis over it. */
  readonly apis?: ReadonlyArray<Api.Any>;
}

const schemaOf = (schema: Schema.Top): SchemaDescription => {
  const codec = Schema.toCodecJson(schema as Schema.Codec<unknown, unknown>);
  const { schema: json, definitions } = Schema.toJsonSchemaDocument(codec);
  return { schema: json, definitions };
};

/** By code unit: `localeCompare` can differ between runtimes, and the hash must not. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const sorted = (items: Iterable<string>): ReadonlyArray<string> =>
  [...new Set(items)].sort(compare);

const byName = <T extends { readonly name?: string; readonly tag?: string }>(
  items: ReadonlyArray<T>,
): ReadonlyArray<T> =>
  [...items].sort((a, b) => compare(a.name ?? a.tag ?? "", b.name ?? b.tag ?? ""));

const middlewareOf = (middleware: Middleware.List): ReadonlyArray<string> =>
  middleware.map((entry) => (entry as unknown as { readonly key: string }).key);

const sourceName = (source: View.Source) =>
  source.kind === "Aggregate"
    ? (source as Aggregate.Any).aggregateName
    : (source as View.Any).viewName;

const keyOf = (key: Key.Any): KeyDescription =>
  Key.isAggregate(key) ? { aggregate: key.aggregateName } : { schema: schemaOf(key) };

const uniqueByTag = <T extends { readonly tag: string }>(items: ReadonlyArray<T>) =>
  byName([...new Map(items.map((item) => [item.tag, item])).values()]);

const describeCommand = (aggregate: Aggregate.Any, command: Command.Any): CommandDescription => ({
  tag: command.tag,
  target: schemaOf(command.target),
  // The command class's own schema carries its input, and its `_tag`.
  input: schemaOf(command),
  events: sorted(command.events.map((event) => event.tag)),
  rejects: sorted(command.rejects.map(rejectionTag)),
  middleware: middlewareOf(command.middleware),
  ...(command.reply ? { reply: schemaOf(command.reply) } : {}),
  ...(aggregate.definition.when
    ? { when: phaseList(aggregate.definition.when[command.tag] ?? []) }
    : {}),
});

const phaseList = (when: ReadonlyArray<string> | "*") => (when === "*" ? when : sorted(when));

const describePhases = (aggregate: Aggregate.Any): PhasesDescription | undefined => {
  const { phases, phaseOf, initial } = aggregate.definition;
  if (!phases || !phaseOf) return undefined;
  return {
    initial: (phaseOf as (state: unknown) => string)(initial),
    phases: byName(
      Object.entries(phases).map(([name, phase]) => ({
        name,
        on: Object.entries(phase.on ?? {})
          .map(([event, to]) => ({ event, to: sorted([to ?? []].flat()) }))
          .sort((a, b) => compare(a.event, b.event)),
      })),
    ),
  };
};

const describeRejection = (rejection: Rejection.Any): MessageDescription => ({
  tag: rejectionTag(rejection),
  schema: schemaOf(rejection),
});

const describeAggregate = (aggregate: Aggregate.Any): AggregateDescription => {
  const def = aggregate.definition;
  const phases = describePhases(aggregate);
  return {
    name: aggregate.aggregateName,
    id: schemaOf(def.id),
    state: schemaOf(def.state),
    commands: byName(def.commands.map((command) => describeCommand(aggregate, command))),
    events: byName(def.events.map((event) => ({ tag: event.tag, schema: schemaOf(event) }))),
    rejections: uniqueByTag(
      def.commands.flatMap((command) => command.rejects.map(describeRejection)),
    ),
    ...(phases ? { phases } : {}),
  };
};

const fieldsSchema = (fields: Fields | undefined) =>
  fields ? schemaOf(Schema.Struct(fields)) : undefined;

/**
 * Stringify with sorted keys, so two equal descriptions give one text.
 * `undefined` members drop out, as they do in JSON.
 */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => compare(a, b)))
      : inner,
  );

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/**
 * FNV-1a, 64 bits, over UTF-8. It finds a change, and it is synchronous on
 * every runtime. It is not cryptographic: don't use it to prove anything.
 */
const hashOf = (text: string): string => {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
};

/**
 * A model as plain JSON data: its aggregates, commands, events, rejections,
 * phases, views, policies, projections, streams and sagas, and the Apis you
 * pass. Use it to draw a map, to diff two versions, or to name a version.
 *
 * `hash` covers all of it, and is the same on every runtime. A change to a
 * schema, a tag, a phase or a link changes it; the order of a declaration
 * doesn't. Code is not data: `decide`, `evolve` and the handlers of policies and
 * sagas are not here, so a change to them keeps the hash. Schemas are hashed as
 * the JSON Schema Effect derives, so an Effect upgrade can change it too.
 *
 * **Example:** Name a version of a model
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import { Bank } from "./Bank.model.ts";
 * import { CustomerApi } from "./CustomerApi.api.ts";
 *
 * const { hash, aggregates } = Domain.describe(Bank, { apis: [CustomerApi] });
 * ```
 */
export const describe = (model: Model.Any, options?: DescribeOptions): Description => {
  const { aggregates, views, policies, projections, streams } = model.definitions;
  const body = {
    name: model.modelName,
    aggregates: byName(aggregates.map(describeAggregate)),
    views: byName(
      views.map((view) => {
        const def = view.definition;
        return {
          name: view.viewName,
          from: sorted(def.from.map(sourceName)),
          key: keyOf(def.key),
          ...(def.state ? { state: schemaOf(def.state) } : {}),
          ...(def.events ? { events: sorted(def.events.map((event) => event.tag)) } : {}),
          middleware: middlewareOf(def.middleware ?? []),
          rejects: sorted((def.rejects ?? []).map(rejectionTag)),
        };
      }),
    ),
    policies: byName(
      policies.map((policy) => {
        const def = policy.definition;
        return {
          name: policy.policyName,
          from: sorted((Array.isArray(def.from) ? def.from : [def.from]).map(sourceName)),
          ...(def.key ? { key: keyOf(def.key) } : {}),
          on: sorted(def.on.map((event) => event.tag)),
        };
      }),
    ),
    projections: byName(
      projections.map((projection) => {
        const def = projection.definition;
        return {
          name: projection.projectionName,
          from: sorted(def.from.map(sourceName)),
          key: keyOf(def.key),
          on: sorted(def.on.map((event) => event.tag)),
          writes: sorted((def.writes ?? []).map((stream) => stream.streamName)),
        };
      }),
    ),
    streams: byName(
      streams.map((stream) => ({
        name: stream.streamName,
        key: keyOf(stream.definition.key),
        entries: sorted(stream.definition.entries.map((event) => event.tag)),
      })),
    ),
    sagas: byName(
      (model.sagas ?? []).map((saga) => {
        const { key, input, result, rejects } = saga.definition;
        const inputSchema = fieldsSchema(input);
        const resultSchema = fieldsSchema(result);
        return {
          name: saga.sagaName,
          key: schemaOf(key),
          ...(inputSchema ? { input: inputSchema } : {}),
          ...(resultSchema ? { result: resultSchema } : {}),
          rejects: sorted((rejects ?? []).map(rejectionTag)),
        };
      }),
    ),
    apis: byName(
      (options?.apis ?? []).map((api) => ({
        name: api.apiName,
        entries: api.entries
          .map((entry) => ({ kind: entry.kind, name: entryName(entry) }))
          .sort((a, b) => compare(a.name, b.name)),
      })),
    ),
  };
  return { ...body, hash: hashOf(canonical(body)) };
};

const entryName = (entry: Api.Entry): string => {
  switch (entry.kind) {
    case "Command":
      return entry.tag;
    case "View":
      return entry.viewName;
    case "Aggregate":
      return entry.aggregateName;
    case "Stream":
      return entry.streamName;
  }
};
