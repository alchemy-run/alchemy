import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import * as Aggregate from "./Aggregate.ts";
import type * as Event from "./Event.ts";
import { FilterJson } from "./Filter.ts";
import * as Key from "./Key.ts";
import * as Middleware from "./Middleware.ts";
import * as Read from "./Read.ts";
import type * as DomainStream from "./Stream.ts";
import * as View from "./View.ts";

/**
 * The RPCs of the views and aggregates an Api exposes. Shared by the Api
 * (which serves them) and the platforms (which push their stream messages
 * over WebSockets), so both encode exactly the same wire values.
 *
 * @internal
 */

/** What `watch` sends: a state with its cursor. */
const snapshotSchema = (state: Schema.Top) => Schema.Struct({ state, cursor: Schema.Number });

/** Something an Api can expose for reading. */
export type Readable = View.Any | Aggregate.Any | DomainStream.Any;

export const nameOf = (entry: Readable) =>
  entry.kind === "View"
    ? entry.viewName
    : entry.kind === "Stream"
      ? entry.streamName
      : entry.aggregateName;

export const union = (members: ReadonlyArray<Schema.Top>) =>
  members.length === 0 ? Schema.Never : Schema.Union(members as ReadonlyArray<Schema.Top>);

/** The events a view emits: its declared events, or the events it applies. */
export const outputEvents = (view: View.Any): ReadonlyArray<Event.Any> => {
  const def = view.definition;
  if (def.events) return def.events;
  const handles = (tag: string, source: string) =>
    Boolean(def.evolve?.[tag] || def.evolve?.[source] || def.emit?.[tag] || def.emit?.[source]);
  const out = new Set<Event.Any>();
  for (const source of def.from) {
    const name = nameOf(source);
    const events =
      source.kind === "View"
        ? outputEvents(source as View.Any)
        : (source as Aggregate.Any).definition.events;
    for (const event of events) if (handles(event.tag, name)) out.add(event);
  }
  return [...out];
};

export interface ReadRpcs {
  /** `get` for views and aggregates; `peek` for streams. */
  readonly get: Rpc.Any;
  readonly watch: Rpc.Any;
  readonly events: Rpc.Any;
  readonly list?: Rpc.Any;
  /** Views only: the state and the cursor it is valid at. */
  readonly snapshot?: Rpc.Any;
}

export const contractOf = (entry: Readable): Read.AnyContract => {
  if (entry.kind === "View" || entry.kind === "Stream") return entry.definition;
  const read = entry.definition.read;
  if (!read) {
    throw new Error(`${entry.aggregateName} has no \`read\` contract, so an Api cannot expose it`);
  }
  return read;
};

const rpcCache = new WeakMap<object, ReadRpcs>();

/** The RPCs of a view or aggregate exposed in an Api. */
export const readRpcs = (entry: Readable): ReadRpcs => {
  const cached = rpcCache.get(entry);
  if (cached) return cached;
  const name = nameOf(entry);
  const contract = contractOf(entry);
  const guard = (rpc: Rpc.Any) => Middleware.apply(rpc, contract.middleware ?? []);
  const error = union(contract.rejects ?? []);
  // A read that takes `atLeast` can also time out waiting for the write.
  const waitError = union([...(contract.rejects ?? []), View.ConsistencyTimeout]);
  let rpcs: ReadRpcs;
  if (entry.kind === "Stream") {
    const def = entry.definition;
    const key = Key.idSchemaOf(def.key);
    const recorded = Schema.Struct({ event: union(def.entries), envelope: Aggregate.Envelope });
    const latest = Schema.NullOr(recorded);
    rpcs = {
      get: guard(
        Rpc.make(`${name}.peek`, {
          payload: {
            key,
            atLeast: Schema.optional(
              Schema.Struct({ stream: Schema.String, version: Schema.Number }),
            ),
          },
          success: latest,
          error: waitError,
        }),
      ),
      watch: guard(
        Rpc.make(`${name}.watch`, {
          payload: { key },
          success: snapshotSchema(latest),
          error,
          stream: true,
        }),
      ),
      events: guard(
        Rpc.make(`${name}.events`, {
          payload: {
            key,
            after: Schema.optional(Schema.Number),
            where: Schema.optional(FilterJson),
          },
          success: Schema.Union([Read.CaughtUp, recorded]),
          error,
          stream: true,
        }),
      ),
      list: guard(
        Rpc.make(`${name}.list`, {
          payload: {
            key,
            where: Schema.optional(FilterJson),
            order: Schema.optional(Schema.Literals(["asc", "desc"])),
            take: Schema.optional(Schema.Number),
            after: Schema.optional(Schema.Number),
          },
          success: Schema.Struct({
            entries: Schema.Array(recorded),
            cursor: Schema.NullOr(Schema.Number),
          }),
          error,
        }),
      ),
    };
  } else if (entry.kind === "View") {
    const def = entry.definition;
    const key = Key.idSchemaOf(def.key);
    const state = Schema.NullOr(def.state ?? Schema.Null);
    const recorded = Schema.Struct({
      event: union(outputEvents(entry)),
      state,
      envelope: Aggregate.Envelope,
    });
    rpcs = {
      get: guard(
        Rpc.make(`${name}.get`, {
          payload: {
            key,
            atLeast: Schema.optional(
              Schema.Struct({ stream: Schema.String, version: Schema.Number }),
            ),
            where: Schema.optional(FilterJson),
          },
          success: state,
          error: waitError,
        }),
      ),
      watch: guard(
        Rpc.make(`${name}.watch`, {
          payload: { key, where: Schema.optional(FilterJson) },
          success: snapshotSchema(state),
          error,
          stream: true,
        }),
      ),
      events: guard(
        Rpc.make(`${name}.events`, {
          payload: {
            key,
            after: Schema.optional(Schema.Number),
            where: Schema.optional(FilterJson),
          },
          success: Schema.Union([Read.CaughtUp, recorded]),
          error,
          stream: true,
        }),
      ),
      list: guard(
        Rpc.make(`${name}.list`, {
          payload: {
            key,
            atLeast: Schema.optional(
              Schema.Struct({ stream: Schema.String, version: Schema.Number }),
            ),
            where: Schema.optional(FilterJson),
            order: Schema.optional(Schema.Literals(["asc", "desc"])),
            take: Schema.optional(Schema.Number),
            after: Schema.optional(Schema.Number),
          },
          success: Schema.Struct({
            entries: Schema.Array(recorded),
            cursor: Schema.NullOr(Schema.Number),
          }),
          error: waitError,
        }),
      ),
      snapshot: guard(
        Rpc.make(`${name}.snapshot`, {
          payload: {
            key,
            atLeast: Schema.optional(
              Schema.Struct({ stream: Schema.String, version: Schema.Number }),
            ),
            where: Schema.optional(FilterJson),
          },
          success: snapshotSchema(state),
          error: waitError,
        }),
      ),
    };
  } else {
    const def = entry.definition;
    const recorded = Schema.Struct({ event: union(def.events), envelope: Aggregate.Envelope });
    rpcs = {
      get: guard(Rpc.make(`${name}.get`, { payload: { key: def.id }, success: def.state, error })),
      watch: guard(
        Rpc.make(`${name}.watch`, {
          payload: { key: def.id },
          success: snapshotSchema(def.state),
          error,
          stream: true,
        }),
      ),
      events: guard(
        Rpc.make(`${name}.events`, {
          payload: { key: def.id, after: Schema.optional(Schema.Number) },
          success: Schema.Union([Read.CaughtUp, recorded]),
          error,
          stream: true,
        }),
      ),
    };
  }
  rpcCache.set(entry, rpcs);
  return rpcs;
};
