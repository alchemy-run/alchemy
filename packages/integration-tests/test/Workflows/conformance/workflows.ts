import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

/** Waits for someone outside to approve it. */
export const Approval = DurableDeferred.make("approval", { success: Schema.String });

export const Approve = Workflow.make("Approve", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

/** Reserves, then waits for approval; interrupted while it waits, it releases the reservation. */
export const Hold = Workflow.make("Hold", {
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

/**
 * Its first activity dies twice before it succeeds, then it sleeps. A defect
 * fails the run instead of the workflow, so the engine retries the run.
 */
export const Flaky = Workflow.make("Flaky", {
  payload: { id: Schema.String, seconds: Schema.Number },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
}).annotate(Workflow.CaptureDefects, false);

/** An activity that dies. By default a defect is the workflow's result, not retried. */
export const Crash = Workflow.make("Crash", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

/** Every conformance workflow, for the engine that hosts them. */
export const workflows = [Greet, Nap, Naps, Approve, Hold, Checkout, Parent, Flaky, Crash] as const;

export const GreetLive = Workflows.layer(
  Greet,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id, name }) {
      const greeting = yield* Activity.make({
        name: "greet",
        success: Schema.String,
        execute: journal.append(id, "greet").pipe(Effect.as(`hello ${name}`)),
      });
      yield* Activity.make({ name: "log", execute: journal.append(id, "log") });
      return greeting;
    });
  }),
);

export const NapLive = Workflows.layer(
  Nap,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id, seconds }) {
      yield* Activity.make({ name: "before", execute: journal.append(id, "before") });
      yield* DurableClock.sleep({
        name: "nap",
        duration: `${seconds} seconds`,
        inMemoryThreshold: 0,
      });
      yield* Activity.make({ name: "after", execute: journal.append(id, "after") });
      return "rested";
    });
  }),
);

export const NapsLive = Workflows.layer(
  Naps,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id, seconds, count }) {
      for (let nap = 0; nap < count; nap++) {
        yield* DurableClock.sleep({
          name: `nap-${nap}`,
          duration: `${seconds} seconds`,
          inMemoryThreshold: 0,
        });
      }
      yield* Activity.make({ name: "after", execute: journal.append(id, "after") });
      return "rested";
    });
  }),
);

export const ApproveLive = Workflows.layer(
  Approve,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id }) {
      yield* Activity.make({ name: "requested", execute: journal.append(id, "requested") });
      const by = yield* DurableDeferred.await(Approval);
      yield* Activity.make({ name: "approved", execute: journal.append(id, `approved:${by}`) });
      return `approved by ${by}`;
    });
  }),
);

export const HoldLive = Workflows.layer(
  Hold,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id }) {
      yield* Activity.make({ name: "reserve", execute: journal.append(id, "reserve") }).pipe(
        Hold.withCompensation(() =>
          Activity.make({ name: "release", execute: journal.append(id, "release") }),
        ),
      );
      const by = yield* DurableDeferred.await(Approval);
      return `held for ${by}`;
    });
  }),
);

export const CheckoutLive = Workflows.layer(
  Checkout,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id, decline }) {
      yield* Activity.make({ name: "reserve", execute: journal.append(id, "reserve") }).pipe(
        Checkout.withCompensation(() =>
          Activity.make({ name: "release", execute: journal.append(id, "release") }),
        ),
      );
      return yield* Activity.make({
        name: "charge",
        success: Schema.String,
        error: Declined,
        execute: decline
          ? journal
              .append(id, "declined")
              .pipe(Effect.andThen(new Declined({ reason: "card declined" })))
          : journal.append(id, "charged").pipe(Effect.as("charged")),
      });
    });
  }),
);

export const ParentLive = Workflows.layer(
  Parent,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id }) {
      const greeting = yield* Greet.execute({ id: `${id}-child`, name: "child" });
      yield* Activity.make({ name: "parent", execute: journal.append(id, `parent:${greeting}`) });
      return `parent got ${greeting}`;
    });
  }),
);

export const FlakyLive = Workflows.layer(
  Flaky,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id, seconds }) {
      yield* Activity.make({
        name: "flaky",
        execute: Effect.gen(function* () {
          yield* journal.append(id, "attempt");
          const attempts = (yield* journal.list(id)).filter((entry) => entry === "attempt").length;
          if (attempts < 3) return yield* Effect.die(`attempt ${attempts} died`);
        }),
      });
      yield* DurableClock.sleep({
        name: "after-flaky",
        duration: `${seconds} seconds`,
        inMemoryThreshold: 0,
      });
      yield* Activity.make({ name: "after", execute: journal.append(id, "after") });
      return "recovered";
    });
  }),
);

export const CrashLive = Workflows.layer(
  Crash,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id }) {
      yield* Activity.make({
        name: "crash",
        execute: journal.append(id, "crash").pipe(Effect.andThen(Effect.die("boom"))),
      });
      return "unreachable";
    });
  }),
);

/** Every conformance workflow's implementation. Provide the cloud's `Journal` and engine. */
export const WorkflowsLive = Layer.mergeAll(
  GreetLive,
  NapLive,
  NapsLive,
  ApproveLive,
  HoldLive,
  CheckoutLive,
  ParentLive,
  FlakyLive,
  CrashLive,
);
