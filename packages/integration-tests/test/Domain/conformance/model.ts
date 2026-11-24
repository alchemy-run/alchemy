/**
 * The model every Domain platform runs for the conformance suite: an
 * aggregate that rejects, a view, a projection fed by that view, a policy
 * that starts a saga, a saga that writes to another aggregate, a policy that
 * schedules and cancels a command, and a decision that commits across two
 * instances, plus a view that refuses every reader, a view behind a
 * middleware whose verdict runs out, a command that dies, and a policy that
 * relays a command from one aggregate instance to the next.
 * Between them the platform hosts every kind of object, runs its workflow
 * engine and its durable timers, and commits atomically across instances.
 */
import * as Domain from "@alchemy.run/domain";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";
import { latencyAggregates, latencyViews } from "./latency-model.ts";

export class Incremented extends Domain.Event("Incremented", { by: Schema.Int }) {}
export class TooBig extends Domain.Rejection("TooBig", { max: Schema.Int }) {}

export class Increment extends Domain.Command("Increment", {
  input: { id: Schema.String, by: Schema.Int },
  events: [Incremented],
  rejects: [TooBig],
  reply: { total: Schema.Int },
}) {}

export class Taken extends Domain.Event("Taken", { by: Schema.Int }) {}
export class Received extends Domain.Event("Received", { by: Schema.Int }) {}
export class Short extends Domain.Rejection("Short", { total: Schema.Int }) {}

/** Move part of one counter's total to another: both change, or neither. */
export class Give extends Domain.Command("Give", {
  input: { from: Schema.String, to: Schema.String, by: Schema.Int },
  events: [Taken, Received],
  rejects: [Short],
  reply: { total: Schema.Int },
}) {}

/** A command whose handler dies, with internals in the defect a client must never see. */
export class Explode extends Domain.Command("Explode", {
  input: { id: Schema.String },
  events: [Incremented],
}) {}

/** What the defect {@link Explode} dies with says: a client must never receive it. */
export const SECRET = "secret: SELECT * FROM accounts";

export class Counter extends Domain.Aggregate("Counter", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  commands: [Increment, Explode],
  keyOf: (command) => command.id,
  events: [Taken, Received],
  decide: {
    Increment: (_, command) =>
      command.by > 10 ? new TooBig({ max: 10 }) : [new Incremented({ by: command.by })],
    Explode: () => Effect.die(new Error(SECRET)),
  },
  evolve: {
    Incremented: (state, event) => ({ total: state.total + event.by }),
    Taken: (state, event) => ({ total: state.total - event.by }),
    Received: (state, event) => ({ total: state.total + event.by }),
  },
  reply: {
    Increment: (state) => ({ total: state.total }),
  },
}) {}

export class Giving extends Domain.Decision(Give, {
  reads: { from: Counter, to: Counter },
  keyOf: (command) => ({ from: command.from, to: command.to }),
  decide: ({ from, to }, command) =>
    command.by > from.state.total
      ? new Short({ total: from.state.total })
      : [from.record(new Taken({ by: command.by })), to.record(new Received({ by: command.by }))],
  reply: ({ from }) => ({ total: from.total }),
}) {}

export class Mirrored extends Domain.Event("Mirrored", { by: Schema.Int }) {}

export class Mirror extends Domain.Command("Mirror", {
  input: { id: Schema.String, by: Schema.Int },
  events: [Mirrored],
}) {}

/** What the saga writes, so a test can see that it ran. */
export class Echo extends Domain.Aggregate("Echo", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  commands: [Mirror],
  keyOf: (command) => command.id,
  decide: {
    Mirror: (_, command) => [new Mirrored({ by: command.by })],
  },
  evolve: {
    Mirrored: (state, event) => ({ total: state.total + event.by }),
  },
}) {}

export class CounterTotal extends Domain.View("CounterTotal", {
  from: [Counter],
  key: Counter,
  state: Schema.Struct({ total: Schema.Int, increments: Schema.Int }),
  initial: { total: 0, increments: 0 },
  evolve: {
    Incremented: (view, event) => ({
      total: view.total + event.by,
      increments: view.increments + 1,
    }),
    Taken: (view, event) => ({ ...view, total: view.total - event.by }),
    Received: (view, event) => ({ ...view, total: view.total + event.by }),
  },
}) {}

/**
 * The same fold as {@link CounterTotal}, added by the model's next version
 * ({@link ConformanceV1}): deployed after the counters have recorded events,
 * it is backfilled from their history.
 */
export class CounterReplay extends Domain.View("CounterReplay", {
  from: [Counter],
  key: Counter,
  state: Schema.Struct({ total: Schema.Int, increments: Schema.Int }),
  initial: { total: 0, increments: 0 },
  evolve: {
    Incremented: (view, event) => ({
      total: view.total + event.by,
      increments: view.increments + 1,
    }),
    Taken: (view, event) => ({ ...view, total: view.total - event.by }),
    Received: (view, event) => ({ ...view, total: view.total + event.by }),
  },
}) {}

/** When a counter's first and latest events were committed, in epoch milliseconds. */
export class CounterTimes extends Domain.View("CounterTimes", {
  from: [Counter],
  key: Counter,
  state: Schema.Struct({ first: Schema.Number, last: Schema.Number }),
  initial: { first: 0, last: 0 },
  evolve: {
    Incremented: (view, _, { at }) => ({
      first: view.first === 0 ? DateTime.toEpochMillis(at) : view.first,
      last: DateTime.toEpochMillis(at),
    }),
  },
}) {}

export class Hidden extends Domain.Rejection("Hidden") {}

/** A counter's total no caller may read: `validate` refuses everyone. */
export class HiddenTotal extends Domain.View("HiddenTotal", {
  from: [Counter],
  key: Counter,
  rejects: [Hidden],
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  evolve: {
    Incremented: (view, event) => ({ total: view.total + event.by }),
  },
}) {}

const HiddenTotalLive = HiddenTotal.toLayer(
  Effect.succeed(
    Effect.fn(function* () {
      return yield* new Hidden();
    }),
  ),
);

export class Expired extends Domain.Rejection("Expired") {}

/**
 * A caller's ticket, as a session middleware checks its token: the
 * `x-ticket` header says how long it holds. `until:<epoch ms>` expires then
 * (a token's own expiry), and `for:<ms>` holds that long from each check (a
 * session still signed in, checked again on every connect).
 */
export class Ticket extends RpcMiddleware.Service<Ticket>()("Conformance/Ticket", {
  error: Expired,
}) {}

export const TicketLive = Layer.succeed(
  Ticket,
  Effect.fn(function* (effect, { headers }) {
    const now = yield* Clock.currentTimeMillis;
    const [kind, value] = (headers["x-ticket"] ?? "").split(":");
    const until = kind === "until" ? Number(value) : kind === "for" ? now + Number(value) : NaN;
    if (!(until > now)) return yield* new Expired();
    // After the read is judged, as `Effect.tap`: the expiry counts wherever it is set.
    return yield* effect.pipe(Effect.tap(Domain.setExpiry(until)));
  }),
);

/** A counter's total for callers with a ticket. */
export class TicketedTotal extends Domain.View("TicketedTotal", {
  from: [Counter],
  key: Counter,
  middleware: [Ticket],
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  evolve: {
    Incremented: (view, event) => ({ total: view.total + event.by }),
  },
}) {}

const TicketedTotalLive = TicketedTotal.toLayer(Effect.succeed(() => Effect.void));

export class TotalRecorded extends Domain.Event("TotalRecorded", { total: Schema.Int }) {}

/** Each counter's totals, as its projection recorded them. */
export class Recorded extends Domain.Stream("Recorded", {
  key: Counter,
  entries: [TotalRecorded],
}) {}

/** Records each counter's total from the view, not the aggregate. */
export class TotalWriter extends Domain.Projection("TotalWriter", {
  from: [CounterTotal],
  key: Counter,
  on: [Incremented],
  writes: [Recorded],
}) {}

/** How long the projection takes over each batch, as a write to a real store does. */
export const RECORD_DELAY = "1 second";

const TotalWriterLive = TotalWriter.toLayer(
  Effect.gen(function* () {
    const recorded = yield* Recorded;
    return Effect.fn(function* (batch) {
      yield* Effect.sleep(RECORD_DELAY);
      for (const input of batch) {
        yield* recorded.append(input, new TotalRecorded({ total: input.state?.total ?? 0 }));
      }
    });
  }),
);

export class Tallied extends Domain.Event("Tallied", { by: Schema.Int }) {}

/** A run's tally key, for a counter of the rebuild case (`<run>~<counter>`); other counters have none. */
export const tallyKey = (counter: string): string | undefined =>
  counter.includes("~") ? counter.split("~")[0] : undefined;

/** Every change to the counters of one run, keyed by the run (see {@link tallyKey}). */
export class Tallies extends Domain.Stream("Tallies", {
  key: Schema.String,
  entries: [Tallied],
}) {}

/** Tallies increments and what a decision takes, through the view. */
export class TallyWriter extends Domain.Projection("TallyWriter", {
  from: [CounterTotal],
  key: Schema.String,
  keyOf: {
    Incremented: ({ source }) => tallyKey(source.id),
    Taken: ({ source }) => tallyKey(source.id),
  },
  on: [Incremented, Taken],
  writes: [Tallies],
}) {}

/**
 * The next version of {@link TallyWriter}: increments only. Bumped to 1, it
 * is rebuilt from the history, which now gives each run fewer inputs than
 * the version before it handled.
 */
export class TallyWriterV1 extends Domain.Projection("TallyWriter", {
  from: [CounterTotal],
  key: Schema.String,
  keyOf: { Incremented: ({ source }) => tallyKey(source.id) },
  on: [Incremented],
  writes: [Tallies],
}) {}

const TallyWriterLive = TallyWriter.toLayer(
  Effect.gen(function* () {
    const tallies = yield* Tallies;
    return Effect.fn(function* (batch) {
      for (const input of batch) {
        const by = input.event._tag === "Taken" ? -input.event.by : input.event.by;
        yield* tallies.append(input, new Tallied({ by }));
      }
    });
  }),
);

const TallyWriterV1Live = TallyWriterV1.toLayer(
  Effect.gen(function* () {
    const tallies = yield* Tallies;
    return Effect.fn(function* (batch) {
      for (const input of batch) yield* tallies.append(input, new Tallied({ by: input.event.by }));
    });
  }),
  { version: 1 },
);

/**
 * Mirrors a counter's first increment onto its Echo; one run per counter.
 * Its step fails its first attempt after it sends, so the step runs again:
 * the second attempt sends the same command, which must commit once.
 */
export class MirrorFirst extends Domain.Saga("MirrorFirst", {
  key: Schema.String,
  input: { by: Schema.Int },
}) {}

/** The first attempt of {@link MirrorFirst}'s step fails after its send. */
export class MirrorFlaky extends Schema.TaggedError<MirrorFlaky>()("MirrorFlaky", {}) {}

const MirrorFirstLive = MirrorFirst.toLayer(
  Effect.gen(function* () {
    const echoes = yield* Echo;
    return Effect.fn(function* ({ key, by }) {
      yield* Activity.make({
        name: "mirror",
        error: MirrorFlaky,
        execute: Effect.gen(function* () {
          yield* echoes.send(new Mirror({ id: key, by })).pipe(Effect.orDie);
          if ((yield* Activity.CurrentAttempt) === 1) return yield* new MirrorFlaky();
        }),
      }).pipe(Activity.retry({ times: 2 }), Effect.orDie);
    });
  }),
);

export class StartMirror extends Domain.Policy("StartMirror", {
  from: Counter,
  on: [Incremented],
}) {}

const StartMirrorLive = StartMirror.toLayer(
  Effect.gen(function* () {
    const mirrors = yield* MirrorFirst;
    return Effect.fn(function* ({ source, event }) {
      yield* mirrors.start(source, { by: event.by });
    });
  }),
);

/** How long a hold lasts before it expires, unless it is released first. */
export const HOLD_WINDOW = "4 seconds";

/**
 * How long every platform's front keeps command receipts: short, so the
 * retention case sees one expire. Long enough that nothing else in the
 * suite sends a command again after it.
 */
export const RECEIPT_RETENTION = "30 seconds";
/** The command id a hold's expiry is scheduled under. */
export const EXPIRY = "expire";

export class HoldPlaced extends Domain.Event("HoldPlaced") {}
export class HoldReleased extends Domain.Event("HoldReleased") {}
export class HoldExpired extends Domain.Event("HoldExpired") {}

export class PlaceHold extends Domain.Command("PlaceHold", {
  input: { id: Schema.String },
  events: [HoldPlaced],
}) {}
export class ReleaseHold extends Domain.Command("ReleaseHold", {
  input: { id: Schema.String },
  events: [HoldReleased],
}) {}
export class ExpireHold extends Domain.Command("ExpireHold", {
  input: { id: Schema.String },
  events: [HoldExpired],
}) {}

export class Hold extends Domain.Aggregate("Hold", {
  id: Schema.String,
  state: Schema.Struct({ status: Schema.Literals(["none", "held", "released", "expired"]) }),
  initial: { status: "none" },
  commands: [PlaceHold, ReleaseHold, ExpireHold],
  keyOf: (command) => command.id,
  decide: {
    PlaceHold: () => [new HoldPlaced()],
    ReleaseHold: () => [new HoldReleased()],
    ExpireHold: () => [new HoldExpired()],
  },
  evolve: {
    HoldPlaced: () => ({ status: "held" as const }),
    HoldReleased: () => ({ status: "released" as const }),
    HoldExpired: () => ({ status: "expired" as const }),
  },
}) {}

/** Schedules a hold's expiry when it is placed, and cancels it when it is released. */
export class HoldDeadline extends Domain.Policy("HoldDeadline", {
  from: Hold,
  on: [HoldPlaced, HoldReleased],
}) {}

const HoldDeadlineLive = HoldDeadline.toLayer(
  Effect.gen(function* () {
    const holds = yield* Hold;
    return Effect.fn(function* ({ source, event }) {
      if (event._tag === "HoldPlaced") {
        yield* holds.schedule(new ExpireHold({ id: source.id }), {
          after: HOLD_WINDOW,
          commandId: EXPIRY,
        });
      } else {
        yield* holds
          .unschedule(source, EXPIRY)
          .pipe(
            Effect.catchTag(
              ["AlreadyExecuted", "AlreadyCancelled", "NotScheduled"],
              () => Effect.void,
            ),
          );
      }
    });
  }),
);

// ---------------------------------------------------------------- a memo, rewritten and compacted

const MemoState = Schema.Struct({ lines: Schema.Array(Schema.String) });
export class Written extends Domain.Event("Written", { text: Schema.String }) {}
export class MemoBroughtForward extends Domain.Event("MemoBroughtForward", {
  state: MemoState,
}) {}
export class Write extends Domain.Command("Write", {
  input: { id: Schema.String, text: Schema.String },
  events: [Written],
}) {}

/** Lines of text: what the rewrite and compaction cases change the history of. */
export class Memo extends Domain.Aggregate("Memo", {
  id: Schema.String,
  state: MemoState,
  initial: { lines: [] },
  commands: [Write],
  events: [MemoBroughtForward],
  keyOf: (command) => command.id,
  decide: { Write: (_, { text }) => [new Written({ text })] },
  evolve: {
    Written: (memo, e) => ({ lines: [...memo.lines, e.text] }),
    MemoBroughtForward: (_, e) => e.state,
  },
}) {}

/** A memo as a client reads it: its lines, joined. */
export class MemoText extends Domain.View("MemoText", {
  from: [Memo],
  key: Memo,
  state: Schema.Struct({ text: Schema.String }),
  initial: { text: "" },
  evolve: {
    Written: (memo, e) => ({ text: memo.text === "" ? e.text : `${memo.text}|${e.text}` }),
    MemoBroughtForward: (_, e) => ({ text: e.state.lines.join("|") }),
  },
}) {}

/** Blanks every line that mentions a word. */
export class Redact extends Domain.Rewrite("Redact", {
  of: Memo,
  input: { word: Schema.String },
  events: {
    Written: (event, { word }) => (event.text.includes(word) ? new Written({ text: "" }) : event),
    // What a compacted memo holds: the same lines, in its roll-up.
    MemoBroughtForward: (event, { word }) =>
      event.state.lines.some((line) => line.includes(word))
        ? new MemoBroughtForward({
            state: { lines: event.state.lines.map((line) => (line.includes(word) ? "" : line)) },
          })
        : event,
  },
}) {}

/** Replaces a memo's history with one event carrying its lines. */
export class MemoForward extends Domain.Compaction("MemoForward", {
  of: Memo,
  rollup: (memo) => [new MemoBroughtForward({ state: memo })],
}) {}

/** The replaced events go nowhere: the case checks what the instance keeps. */
const MemoForwardLive = MemoForward.toLayer(
  Effect.succeed(Effect.fn(function* (_batch: Domain.Compaction.Batch<typeof Memo>) {})),
);

// ---------------------------------------------------------------- a relay of hops

export class Passed extends Domain.Event("Passed", { chain: Schema.String, left: Schema.Int }) {}

export class Pass extends Domain.Command("Pass", {
  input: { id: Schema.String, chain: Schema.String, left: Schema.Int },
  events: [Passed],
}) {}

/** One hop of a relay, `<chain>-<left>`: hop 0 is the last. */
export class Hop extends Domain.Aggregate("Hop", {
  id: Schema.String,
  state: Schema.Struct({ passed: Schema.Boolean }),
  initial: { passed: false },
  commands: [Pass],
  keyOf: (command) => command.id,
  decide: { Pass: (_, { chain, left }) => [new Passed({ chain, left })] },
  evolve: { Passed: () => ({ passed: true }) },
}) {}

/** Passes the relay on to the next hop, until none are left. */
export class PassOn extends Domain.Policy("PassOn", { from: Hop, on: [Passed] }) {}

const PassOnLive = PassOn.toLayer(
  Effect.gen(function* () {
    const hops = yield* Hop;
    return Effect.fn(function* ({ event }) {
      if (event.left === 0) return;
      const left = event.left - 1;
      yield* hops.send(new Pass({ id: `${event.chain}-${left}`, chain: event.chain, left }));
    });
  }),
);

export class Conformance extends Domain.Model("Conformance", {
  aggregates: [Counter, Echo, Hold, Hop, Memo, ...latencyAggregates],
  decisions: [Giving],
  views: [CounterTotal, CounterTimes, HiddenTotal, TicketedTotal, MemoText, ...latencyViews],
  projections: [TotalWriter, TallyWriter],
  streams: [Recorded, Tallies],
  policies: [StartMirror, HoldDeadline, PassOn],
  sagas: [MirrorFirst],
  rewrites: [Redact],
  compactions: [MemoForward],
}) {}

/**
 * The model's next version: {@link TallyWriterV1} in place of {@link TallyWriter},
 * and a view it adds, {@link CounterReplay}.
 */
export class ConformanceV1 extends Domain.Model("Conformance", {
  aggregates: [Counter, Echo, Hold, Hop, Memo, ...latencyAggregates],
  decisions: [Giving],
  views: [
    CounterTotal,
    CounterTimes,
    HiddenTotal,
    TicketedTotal,
    MemoText,
    CounterReplay,
    ...latencyViews,
  ],
  projections: [TotalWriter, TallyWriterV1],
  streams: [Recorded, Tallies],
  policies: [StartMirror, HoldDeadline, PassOn],
  sagas: [MirrorFirst],
  rewrites: [Redact],
  compactions: [MemoForward],
}) {}

/** The model's Api: its counter and views, served at the front's `/api` (with {@link TicketLive}). */
export class ConformanceApi extends Domain.Api("ConformanceApi", {
  model: Conformance,
  commands: ["Increment", "Explode", "Give"],
  views: ["CounterTotal", "HiddenTotal", "TicketedTotal"],
}) {}

/** What the latency benchmark sends and reads: see `latency-model.ts`. */
export class LatencyApi extends Domain.Api("LatencyApi", {
  model: Conformance,
  commands: ["Increment", "TickBare", "TickOne", "TickFour", "TickChain", "TickShared"],
  views: ["CounterTotal", "OneView", "ChainSecond", "SharedByGroup"],
}) {}

const handlers = Layer.mergeAll(
  StartMirrorLive,
  MirrorFirstLive,
  HoldDeadlineLive,
  PassOnLive,
  HiddenTotalLive,
  TicketedTotalLive,
  TotalWriterLive,
  MemoForwardLive,
);

/**
 * A Vault whose keys live on the model's own host, one object per subject,
 * each wrapped under a root key.
 */
const ConformanceVault = Domain.VaultLive.pipe(
  Layer.provide(
    Layer.merge(Domain.HostKeyStore, Domain.RootKeyWrap(Redacted.make("c0".repeat(32)))),
  ),
);

/** The model's Layer, given the platform it runs on. */
export const ConformanceLive = Conformance.layer(Layer.merge(handlers, TallyWriterLive)).pipe(
  Layer.provideMerge(ConformanceVault),
);

/**
 * The next version's Layer: deployed over {@link ConformanceLive}, it rebuilds
 * the tallies and backfills {@link CounterReplay}.
 */
export const ConformanceLiveV1 = ConformanceV1.layer(Layer.merge(handlers, TallyWriterV1Live)).pipe(
  Layer.provideMerge(ConformanceVault),
);
