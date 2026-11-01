import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Activity, DurableClock, DurableDeferred, Workflow } from "effect/workflow";
import { Journal } from "./journal.ts";

export class Declined extends Schema.TaggedError<Declined>()("Declined", {
  reason: Schema.String,
}) {}

/** Two activities and a result. */
export const Greet = Workflow.make("Greet", {
  payload: { id: Schema.String, name: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

/** Sleeps durably between two activities. */
export const Nap = Workflow.make("Nap", {
  payload: { id: Schema.String, seconds: Schema.Number },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

/** Sleeps several times in a row, so each wake-up is scheduled from the one before. */
export const Naps = Workflow.make("Naps", {
  payload: { id: Schema.String, seconds: Schema.Number, count: Schema.Number },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

/**
 * Its first activity dies twice before it succeeds, then it sleeps. A defect
 * fails the run instead of the workflow, so the engine retries the run.
 */
export const Flaky = Workflow.make("Flaky", {
  payload: { id: Schema.String, seconds: Schema.Number },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
}).annotate(Workflow.CaptureDefects, false);

/** Waits for someone outside to approve it. */
export const Approval = DurableDeferred.make("approval", { success: Schema.String });

export const Approve = Workflow.make("Approve", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

/** Reserves, then charges; a declined charge releases the reservation. */
export const Checkout = Workflow.make("Checkout", {
  payload: { id: Schema.String, decline: Schema.Boolean },
  success: Schema.String,
  error: Declined,
  idempotencyKey: ({ id }) => id,
});

/** Runs Greet as a child workflow. */
export const Parent = Workflow.make("Parent", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

/** Appends an entry to a run's journal, which is how the tests see what ran. */
const Recorder = Effect.gen(function* () {
  const journals = yield* Journal;
  // Right after a deploy, a call to the journal can fail in transit.
  return (id: string, entry: string) =>
    journals
      .getByName(id)
      .append(entry)
      .pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 20 }), Effect.orDie);
});

/** Reads a run's journal. */
const Reader = Effect.gen(function* () {
  const journals = yield* Journal;
  return (id: string) =>
    journals
      .getByName(id)
      .list()
      .pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 20 }), Effect.orDie);
});

export const GreetLive = Workflows.layer(
  Greet,
  Effect.gen(function* () {
    const record = yield* Recorder;
    return Effect.fn(function* ({ id, name }) {
      const greeting = yield* Activity.make({
        name: "greet",
        success: Schema.String,
        execute: record(id, "greet").pipe(Effect.as(`hello ${name}`)),
      });
      yield* Activity.make({ name: "log", execute: record(id, "log") });
      return greeting;
    });
  }),
);

export const NapLive = Workflows.layer(
  Nap,
  Effect.gen(function* () {
    const record = yield* Recorder;
    return Effect.fn(function* ({ id, seconds }) {
      yield* Activity.make({ name: "before", execute: record(id, "before") });
      yield* DurableClock.sleep({
        name: "nap",
        duration: `${seconds} seconds`,
        inMemoryThreshold: 0,
      });
      yield* Activity.make({ name: "after", execute: record(id, "after") });
      return "rested";
    });
  }),
);

export const NapsLive = Workflows.layer(
  Naps,
  Effect.gen(function* () {
    const record = yield* Recorder;
    return Effect.fn(function* ({ id, seconds, count }) {
      for (let nap = 0; nap < count; nap++) {
        yield* DurableClock.sleep({
          name: `nap-${nap}`,
          duration: `${seconds} seconds`,
          inMemoryThreshold: 0,
        });
      }
      yield* Activity.make({ name: "after", execute: record(id, "after") });
      return "rested";
    });
  }),
);

export const FlakyLive = Workflows.layer(
  Flaky,
  Effect.gen(function* () {
    const record = yield* Recorder;
    const read = yield* Reader;
    return Effect.fn(function* ({ id, seconds }) {
      yield* Activity.make({
        name: "flaky",
        execute: Effect.gen(function* () {
          yield* record(id, "attempt");
          const attempts = (yield* read(id)).filter((entry) => entry === "attempt").length;
          if (attempts < 3) return yield* Effect.die(`attempt ${attempts} died`);
        }),
      });
      yield* DurableClock.sleep({
        name: "after-flaky",
        duration: `${seconds} seconds`,
        inMemoryThreshold: 0,
      });
      yield* Activity.make({ name: "after", execute: record(id, "after") });
      return "recovered";
    });
  }),
);

export const ApproveLive = Workflows.layer(
  Approve,
  Effect.gen(function* () {
    const record = yield* Recorder;
    return Effect.fn(function* ({ id }) {
      yield* Activity.make({ name: "requested", execute: record(id, "requested") });
      const by = yield* DurableDeferred.await(Approval);
      yield* Activity.make({ name: "approved", execute: record(id, `approved:${by}`) });
      return `approved by ${by}`;
    });
  }),
);

export const CheckoutLive = Workflows.layer(
  Checkout,
  Effect.gen(function* () {
    const record = yield* Recorder;
    return Effect.fn(function* ({ id, decline }) {
      yield* Activity.make({ name: "reserve", execute: record(id, "reserve") }).pipe(
        Checkout.withCompensation(() =>
          Activity.make({ name: "release", execute: record(id, "release") }),
        ),
      );
      return yield* Activity.make({
        name: "charge",
        success: Schema.String,
        error: Declined,
        execute: decline
          ? record(id, "declined").pipe(Effect.andThen(new Declined({ reason: "card declined" })))
          : record(id, "charged").pipe(Effect.as("charged")),
      });
    });
  }),
);

export const ParentLive = Workflows.layer(
  Parent,
  Effect.gen(function* () {
    const record = yield* Recorder;
    return Effect.fn(function* ({ id }) {
      const greeting = yield* Greet.execute({ id: `${id}-child`, name: "child" });
      yield* Activity.make({ name: "parent", execute: record(id, `parent:${greeting}`) });
      return `parent got ${greeting}`;
    });
  }),
);

export const WorkflowsLive = Layer.mergeAll(
  GreetLive,
  NapLive,
  NapsLive,
  FlakyLive,
  ApproveLive,
  CheckoutLive,
  ParentLive,
);
