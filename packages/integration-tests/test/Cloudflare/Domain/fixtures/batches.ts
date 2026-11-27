import { DurableObjectState } from "@alchemy.run/cloudflare/Workers/DurableObjectState";
import * as Domain from "@alchemy.run/domain";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** How long a batch waits for more inputs before it runs short. */
export const BATCH_WAIT = "5 seconds";

/** How long the projection takes over a slow ping. */
export const SLOW = "12 seconds";

/** How long the policy takes to answer a ping slowly: longer than a drain's 60-second lease. */
export const ANSWER_SLOWLY = "70 seconds";

/**
 * An object told to reset while it handles a ping does so only while the
 * ping is this young: its first attempt, not the one after the reset.
 */
const RESET_WITHIN_MILLIS = 30_000;

/** A group of pings, projected together. */
export const GroupId = Schema.String.pipe(Schema.brand("GroupId"));

/**
 * Which object resets (as an eviction does) while it handles a ping, the
 * first time; `view` fails the ping's first delivery to {@link PingCount}.
 */
export const Reset = Schema.Literals(["none", "projection", "policy", "view"]);
export type Reset = typeof Reset.Type;

/** Whether the policy answers a ping with a ping of its own, and how. */
export const Answer = Schema.Literals(["none", "now", "slowly"]);
export type Answer = typeof Answer.Type;

export class Pinged extends Domain.Event("Pinged", {
  group: GroupId,
  slow: Schema.Boolean,
  reset: Reset,
  answer: Answer,
}) {}

export class Ping extends Domain.Command("Ping", {
  input: { id: Schema.String, group: GroupId, slow: Schema.Boolean, reset: Reset, answer: Answer },
  events: [Pinged],
}) {}

export class Pinger extends Domain.Aggregate("Pinger", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Ping],
  keyOf: (command) => command.id,
  decide: {
    Ping: (_, { group, slow, reset, answer }) => [new Pinged({ group, slow, reset, answer })],
  },
  evolve: { Pinged: (s) => s },
}) {}

export class Pong extends Domain.Event("Pong", { ping: Schema.String }) {}

/** One ordered log per group: a pong for each ping the projection has run. */
export class Pongs extends Domain.Stream("Pongs", { key: GroupId, entries: [Pong] }) {}

/**
 * Reset the Durable Object this runs in with `ctx.abort()`, as an eviction
 * or a crash does: its in-flight work stops where it is, and the next event
 * starts a new instance over the same storage.
 */
const resetIfFirstAttempt = Effect.fn(function* (at: DateTime.Utc) {
  const age = (yield* Clock.currentTimeMillis) - DateTime.toEpochMillis(at);
  if (age > RESET_WITHIN_MILLIS) return;
  const state = yield* Effect.serviceOption(DurableObjectState);
  const runtime = yield* Effect.serviceOption(RuntimeContext);
  if (Option.isNone(state) || Option.isNone(runtime)) {
    return yield* Effect.die("a reset ping ran outside a Durable Object");
  }
  yield* state.value
    .abort("reset by a test ping")
    .pipe(Effect.provideService(RuntimeContext, runtime.value));
  // The reset ends this instance; nothing after it runs.
  return yield* Effect.never;
});

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
        if (input.event.reset === "projection") yield* resetIfFirstAttempt(input.envelope.at);
        if (input.event.slow) yield* Effect.sleep(SLOW);
        yield* pongs.append(input, new Pong({ ping: input.source.id }));
      }
    });
  }),
  { batch: { size: 10, wait: BATCH_WAIT } },
);

/**
 * Answers a ping with a ping from a new pinger, `<id>-answer-<n>`, in the
 * same group: each run of the reaction answers once, so the group's pongs
 * count its runs.
 */
export class Answerer extends Domain.Policy("Answerer", {
  from: Pinger,
  on: [Pinged],
}) {}

export const AnswererLive = Answerer.toLayer(
  Effect.gen(function* () {
    const pingers = yield* Pinger;
    return Effect.fn(function* ({ source, event, envelope }) {
      if (event.answer === "none") return;
      if (event.reset === "policy") yield* resetIfFirstAttempt(envelope.at);
      if (event.answer === "slowly") yield* Effect.sleep(ANSWER_SLOWLY);
      const run = yield* Effect.sync(() => crypto.randomUUID().slice(0, 8));
      yield* pingers
        .send(
          new Ping({
            id: `${source.id}-answer-${run}`,
            group: event.group,
            slow: false,
            reset: "none",
            answer: "none",
          }),
        )
        .pipe(Effect.orDie);
    });
  }),
);

/** The pingers whose first delivery to {@link PingCount} failed, in this isolate. */
const failedOnce = new Set<string>();

/**
 * How many pings each group has seen. A ping told to reset the view fails
 * its first delivery, as a crash of the pinger's object before it delivers
 * does: the delivery stays staged on the pinger.
 */
export class PingCount extends Domain.View("PingCount", {
  from: [Pinger],
  key: GroupId,
  keyOf: { Pinger: ({ event }) => event.group },
  state: Schema.Struct({ pings: Schema.Number }),
  initial: { pings: 0 },
  evolve: {
    Pinged: (s, e, { source }) => {
      if (e.reset === "view" && !failedOnce.has(source.id)) {
        failedOnce.add(source.id);
        // A defect, as a crash is: evolve has no error channel to fail on.
        throw new Error(`the first delivery of ${source.id}'s ping fails`);
      }
      return { pings: s.pings + 1 };
    },
  },
}) {}

export class Batches extends Domain.Model("Batches", {
  aggregates: [Pinger],
  views: [PingCount],
  projections: [PongWriter],
  streams: [Pongs],
  policies: [Answerer],
}) {}
