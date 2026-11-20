import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Aggregate from "../../Aggregate.ts";
import * as Decision from "../../Decision.ts";
import { settle } from "../../internal.ts";

/** One instance a decision read, and what the decision left of it. */
export interface Wrote {
  readonly aggregate: Aggregate.Any;
  readonly id: string;
  readonly stream: string;
  readonly before: unknown;
  readonly version: number;
  /** What the decision recorded on it: empty when it only read it. */
  readonly events: ReadonlyArray<{ readonly _tag: string }>;
  readonly after: unknown;
}

/** What the real `decide` of a decision does with a command, and the real `evolve` of each instance after it. */
export type Ran =
  | {
      readonly _tag: "Accepted";
      /** Every event, in the order `decide` recorded them. */
      readonly events: ReadonlyArray<{ readonly _tag: string }>;
      /** Every instance read, each once. */
      readonly wrote: ReadonlyArray<Wrote>;
      /** For each name in `reads`: its instance's stream, or each of its instances'. */
      readonly streams: Readonly<Record<string, string | ReadonlyArray<string>>>;
    }
  | { readonly _tag: "Rejected"; readonly rejection: { readonly _tag: string } }
  | { readonly _tag: "Unpredictable"; readonly cause: Cause.Cause<unknown> };

/** The state and version of each stream a decision may read: one left out is a new instance. */
export type States = ReadonlyMap<string, { readonly state: unknown; readonly version: number }>;

/**
 * Run a decision's own `decide`, and each instance's `evolve` on what it
 * records, without a platform: what the kernel does for the same states,
 * command and time.
 */
export const run = (
  decision: Decision.Any,
  command: { readonly _tag: string },
  states: States,
  options: {
    readonly now: DateTime.Utc;
    readonly commandId: string;
    readonly context: Context.Context<never>;
  },
): Ran => {
  const def = decision.definition;
  const unpredictable = (reason: string): Ran => ({
    _tag: "Unpredictable",
    cause: Cause.die(new Error(reason)),
  });
  const ids = def.keyOf(command);
  const read = new Map<
    string,
    { aggregate: Aggregate.Any; id: string; state: unknown; version: number }
  >();
  const streams: Record<string, string | ReadonlyArray<string>> = {};
  for (const [name, aggregate] of Object.entries(def.reads)) {
    const streamOf = (id: string) => {
      const stream = `${aggregate.aggregateName}/${id}`;
      if (!read.has(stream)) {
        const stored = states.get(stream);
        read.set(stream, {
          aggregate,
          id,
          state: stored ? stored.state : aggregate.definition.initial,
          version: stored?.version ?? 0,
        });
      }
      return stream;
    };
    const id = ids[name];
    if (id === undefined) return unpredictable(`keyOf gives no id for ${name}`);
    streams[name] = typeof id === "string" ? streamOf(id) : id.map(streamOf);
  }
  const seen = (stream: string) => {
    const instance = read.get(stream)!;
    return {
      id: instance.id,
      stream,
      state: instance.state,
      version: instance.version,
      record: (event: unknown) => Decision.recorded(stream, event),
    };
  };
  let decided = def.decide(
    Object.fromEntries(
      Object.entries(streams).map(([name, stream]) => [
        name,
        typeof stream === "string" ? seen(stream) : stream.map(seen),
      ]),
    ),
    command,
    { commandId: options.commandId, now: options.now },
  );
  if (Effect.isEffect(decided)) {
    const settled = decided.pipe(
      Effect.provideContext(options.context as Context.Context<unknown>),
      Effect.runSyncExit,
      settle,
    );
    if (settled._tag === "Failed") return { _tag: "Unpredictable", cause: settled.cause };
    decided = settled.decision;
  }
  if (!Array.isArray(decided))
    return { _tag: "Rejected", rejection: decided as { readonly _tag: string } };
  const recorded = new Map<string, Array<{ readonly _tag: string }>>();
  const events: Array<{ readonly _tag: string }> = [];
  for (const item of decided as ReadonlyArray<unknown>) {
    const stream = Decision.recordedOn(item);
    if (stream === undefined || !read.has(stream))
      return unpredictable("decide returns an event it did not record on an instance it read");
    const event = (item as Decision.Recorded<{ readonly _tag: string }>).event;
    events.push(event);
    const list = recorded.get(stream);
    if (list) list.push(event);
    else recorded.set(stream, [event]);
  }
  const wrote: Array<Wrote> = [];
  for (const [stream, instance] of read) {
    const made = recorded.get(stream) ?? [];
    let next = instance.state;
    for (const [index, event] of made.entries()) {
      const fold = (
        instance.aggregate.definition.evolve as unknown as Record<
          string,
          ((state: unknown, event: unknown, envelope: unknown) => unknown) | undefined
        >
      )[event._tag];
      if (!fold)
        return unpredictable(`${instance.aggregate.aggregateName} has no evolve for ${event._tag}`);
      next = fold(next, event, {
        id: instance.id,
        stream,
        seq: instance.version + index + 1,
        at: options.now,
        commandId: options.commandId,
        correlationId: options.commandId,
      });
    }
    wrote.push({
      aggregate: instance.aggregate,
      id: instance.id,
      stream,
      before: instance.state,
      version: instance.version,
      events: made,
      after: next,
    });
  }
  return { _tag: "Accepted", events, wrote, streams };
};

/** A value for each name in `reads`, of its instance or of each of its instances. */
export const byName = <A>(
  streams: Readonly<Record<string, string | ReadonlyArray<string>>>,
  of: (stream: string) => A,
): Readonly<Record<string, A | ReadonlyArray<A>>> =>
  Object.fromEntries(
    Object.entries(streams).map(([name, stream]) => [
      name,
      typeof stream === "string" ? of(stream) : stream.map(of),
    ]),
  );
