import * as Domain from "@alchemy.run/domain";
import * as Foldkit from "@alchemy.run/domain/Foldkit";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  Counter as CounterAggregate,
  CounterApi,
  CounterId,
  Incremented,
  Limit,
  Unauthenticated,
} from "./FoldkitCounter.ts";

const Counter = Foldkit.make(CounterApi);
const target = CounterId.make("one");
Counter.Reset({ target, input: {}, commandId: "page:0" });
Counter.Increment({ target, input: { amount: 1 }, commandId: "page:1" });
// @ts-expect-error the target is branded
Counter.Increment({ target: "one", input: { amount: 1 }, commandId: "page:1" });
// @ts-expect-error input uses the decoded side of the transform
Counter.Increment({ target, input: { amount: "1" }, commandId: "page:1" });
// @ts-expect-error required command input cannot be omitted
Counter.Increment({ target, commandId: "page:1" });

const check = (message: typeof Counter.Message.Type) =>
  Counter.Message.match<void>(message, {
    SucceededIncrement: ({ reply }) => {
      const total: number = reply.total;
      void total;
    },
    FailedIncrement: ({ failure }) => {
      if (failure._tag === "Rejected") {
        const rejection: typeof Limit.Type = failure.rejection;
        void rejection;
      }
    },
    SucceededReset: ({ reply }) => {
      const empty: void = reply;
      void empty;
    },
    FailedReset: ({ failure }) => {
      if (failure._tag === "Denied") {
        const denied: Unauthenticated = failure.error;
        void denied;
      }
    },
  });
const schema: Schema.Top = Counter.Message;
const requirements: Effect.Effect<
  typeof Counter.Message.Type,
  never,
  typeof CounterApi.Client.Identifier
> = Counter.Increment({ target, input: { amount: 1 }, commandId: "page:1" }).effect;
void check;
void schema;
void requirements;

// @ts-expect-error only Api read names are exposed
Counter.UnknownView.watch({});
const watchOptions = {
  key: (_model: { id: typeof CounterId.Type }) => target,
  toMessage: (snapshot: Foldkit.Snapshot<{ readonly total: number }>) => snapshot.cursor,
  onFailure: (
    _error: Domain.Api.ReadError<typeof import("./FoldkitCounter.ts").Total.definition>,
  ) => 0,
  onDefect: () => 0,
};
Counter.Total.watch(watchOptions);
// @ts-expect-error read keys preserve their brand
Counter.Total.watch({ ...watchOptions, key: () => "one" });
Counter.Total.watch({
  ...watchOptions,
  // @ts-expect-error snapshot state has the View state type
  toMessage: (snapshot: Foldkit.Snapshot<string>) => snapshot.cursor,
});
Counter.Total.watch<{ id: typeof CounterId.Type }, number>({
  ...watchOptions,
  // @ts-expect-error all callbacks produce the selected Message type
  onDefect: () => "failed",
});
Counter.Counter.watch(watchOptions);
Counter.Counter.events({
  key: () => target,
  cursor: () => Option.none(),
  onEntry: (entry) => {
    const amount: number = entry.event.amount;
    return amount;
  },
  onCaughtUp: (cursor) => cursor,
  onFailure: () => 0,
  onDefect: () => 0,
});
Counter.Outputs.watch({
  key: () => target,
  toMessage: (snapshot) =>
    Option.match(snapshot.state, { onNone: () => 0, onSome: (entry) => entry.event.amount }),
  onFailure: () => 0,
  onDefect: () => 0,
});
Counter.Outputs.events({
  key: () => target,
  cursor: () => Option.none(),
  onEntry: (entry) => entry.event.amount,
  onCaughtUp: (cursor) => cursor,
  onFailure: () => 0,
  onDefect: () => 0,
});
const flags: Option.Option<{
  readonly state: Option.Option<{ readonly total: number }>;
  readonly cursor: number;
}> = Counter.Total.decodeSnapshotFlags({});
void flags;
class MessageView extends Domain.View("Message", {
  key: CounterId,
  state: Schema.Number,
  initial: 0,
  from: [],
}) {}
class CollisionApi extends Domain.Api("CollisionApi", MessageView) {}
// @ts-expect-error Message is reserved for command results
Foldkit.make(CollisionApi);

const decodedFlags = Schema.decodeUnknownOption(Counter.Total.SnapshotFlags)({});
void decodedFlags;
Counter.Total.events({
  key: () => target,
  // @ts-expect-error cursors use Option<number>
  cursor: () => 1,
  onEntry: (entry) => entry.envelope.seq,
  onCaughtUp: (cursor) => cursor,
  onFailure: () => 0,
  onDefect: () => 0,
});

// Queries: one Command per Api query, with typed results and failures.
const Row = Schema.Struct({ id: Schema.String, amount: Schema.Number });
class Ledger extends Domain.Projection("FoldkitLedger", {
  from: [CounterAggregate],
  key: CounterAggregate,
  on: [Incremented],
}) {}
class Entries extends Domain.Query("Entries", {
  input: { counter: CounterId },
  row: Row,
  from: [Ledger],
  rejects: [Limit],
}) {}
class Count extends Domain.Query("Count", { success: Schema.Number }) {}
class QueryApi extends Domain.Api("QueryApi", Entries, Count) {}
const Queries = Foldkit.make(QueryApi);
Queries.Entries({ input: { counter: target }, requestId: "q:0" });
Queries.Entries({
  input: { counter: target },
  requestId: "q:1",
  atLeast: { stream: "Counter/one", version: 1 },
  after: "cursor",
  take: 10,
});
Queries.Count({ input: {}, requestId: "q:2" });
// @ts-expect-error query input keys preserve their brand
Queries.Entries({ input: { counter: "one" }, requestId: "q:3" });
// @ts-expect-error a query needs a request id
Queries.Entries({ input: { counter: target } });
const read = (message: typeof Queries.Message.Type) =>
  Queries.Message.match<void>(message, {
    SucceededEntries: ({ requestId, result }) => {
      const rows: ReadonlyArray<{ readonly id: string; readonly amount: number }> = result.entries;
      const cursor: string | null = result.cursor;
      void [requestId, rows, cursor];
    },
    FailedEntries: ({ failure }) => {
      if (failure._tag === "Rejected") {
        const rejection: typeof Limit.Type = failure.rejection;
        void rejection;
      }
      // A query that reads projections may time out waiting for `atLeast`.
      const tag: "Rejected" | "Denied" | "TimedOut" | "Unknown" = failure._tag;
      void tag;
    },
    SucceededCount: ({ result }) => {
      const count: number = result;
      void count;
    },
    FailedCount: ({ failure }) => {
      // @ts-expect-error a query with no projections never times out
      const tag: "TimedOut" = failure._tag;
      void tag;
    },
  });
const queryRequirements: Effect.Effect<
  typeof Queries.Message.Type,
  never,
  typeof QueryApi.Client.Identifier
> = Queries.Count({ input: {}, requestId: "q:4" }).effect;
void read;
void queryRequirements;
