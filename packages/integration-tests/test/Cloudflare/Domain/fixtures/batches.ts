import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** How long a batch waits for more inputs before it runs short. */
export const BATCH_WAIT = "5 seconds";

/** How long the projection takes over a slow ping. */
export const SLOW = "12 seconds";

/** A group of pings, projected together. */
export const GroupId = Schema.String.pipe(Schema.brand("GroupId"));

export class Pinged extends Domain.Event("Pinged", { group: GroupId, slow: Schema.Boolean }) {}

export class Ping extends Domain.Command("Ping", {
  target: Schema.String,
  input: { group: GroupId, slow: Schema.Boolean },
  events: [Pinged],
}) {}

export class Pinger extends Domain.Aggregate("Pinger", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Ping],
  decide: { Ping: (_, { group, slow }) => [new Pinged({ group, slow })] },
  evolve: { Pinged: (s) => s },
}) {}

export class Pong extends Domain.Event("Pong", { ping: Schema.String }) {}

/** One ordered log per group: a pong for each ping the projection has run. */
export class Pongs extends Domain.Stream("Pongs", { key: GroupId, entries: [Pong] }) {}

/** Answers each group's pings in batches. */
export class PongWriter extends Domain.Projection("PongWriter", {
  from: [Pinger],
  key: GroupId,
  keyOf: { Pinger: ({ event }) => event.group },
  on: [Pinged],
  writes: [Pongs],
}) {}

export const PongWriterLive = PongWriter.toLayer(
  Effect.gen(function* () {
    const pongs = yield* Pongs;
    return Effect.fn(function* (batch) {
      for (const input of batch) {
        if (input.event.slow) yield* Effect.sleep(SLOW);
        yield* pongs.append(input, new Pong({ ping: input.source.id }));
      }
    });
  }),
  { batch: { size: 10, wait: BATCH_WAIT } },
);

/** How many pings each pinger has sent. */
export class PingCount extends Domain.View("PingCount", {
  from: [Pinger],
  key: Pinger,
  state: Schema.Int,
  initial: 0,
  evolve: { Pinged: (count) => count + 1 },
}) {}

export class Counted extends Domain.Event("Counted", { ping: Schema.String, count: Schema.Int }) {}

/** One ordered log per group: each ping's count, as the view saw it. */
export class Counts extends Domain.Stream("Counts", { key: GroupId, entries: [Counted] }) {}

/** Records each group's ping counts from the view, not the aggregate. */
export class CountWriter extends Domain.Projection("CountWriter", {
  from: [PingCount],
  key: GroupId,
  keyOf: { PingCount: ({ event }) => event.group },
  on: [Pinged],
  writes: [Counts],
}) {}

/** How long the projection takes over each count, as a write to a real store does. */
export const COUNT_DELAY = "1 second";

export const CountWriterLive = CountWriter.toLayer(
  Effect.gen(function* () {
    const counts = yield* Counts;
    return Effect.fn(function* (batch) {
      yield* Effect.sleep(COUNT_DELAY);
      for (const input of batch) {
        yield* counts.append(
          input,
          new Counted({ ping: input.source.id, count: input.state ?? 0 }),
        );
      }
    });
  }),
);

export class Batches extends Domain.Model("Batches", {
  aggregates: [Pinger],
  views: [PingCount],
  projections: [PongWriter, CountWriter],
  streams: [Pongs, Counts],
}) {}
