import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Activity, DurableClock, DurableDeferred, Workflow } from "effect/workflow";

export class Declined extends Schema.TaggedError<Declined>()("Declined", {
  reason: Schema.String,
}) {}

/** Two steps and a result. */
export const Greet = Workflow.make("Greet", {
  payload: { id: Schema.String, name: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

/** Sleeps durably between two steps; an interrupt undoes the first. */
export const Nap = Workflow.make("Nap", {
  payload: { id: Schema.String, seconds: Schema.Number },
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

// Each step's name is in the execution's history, which is how the tests see what ran.
export const WorkflowsLive = Layer.mergeAll(
  Workflows.layer(
    Greet,
    Effect.fn(function* ({ name }) {
      const greeting = yield* Activity.make({
        name: "greet",
        success: Schema.String,
        execute: Effect.succeed(`hello ${name}`),
      });
      yield* Activity.make({ name: "log", execute: Effect.void });
      return greeting;
    }),
  ),
  Workflows.layer(
    Nap,
    Effect.fn(function* ({ seconds }) {
      yield* Activity.make({ name: "before", execute: Effect.void }).pipe(
        Nap.withCompensation(() => Activity.make({ name: "undo", execute: Effect.void })),
      );
      yield* DurableClock.sleep({
        name: "nap",
        duration: `${seconds} seconds`,
        inMemoryThreshold: 0,
      });
      yield* Activity.make({ name: "after", execute: Effect.void });
      return "rested";
    }),
  ),
  Workflows.layer(
    Approve,
    Effect.fn(function* () {
      yield* Activity.make({ name: "requested", execute: Effect.void });
      const by = yield* DurableDeferred.await(Approval);
      yield* Activity.make({ name: "approved", execute: Effect.void });
      return `approved by ${by}`;
    }),
  ),
  Workflows.layer(
    Checkout,
    Effect.fn(function* ({ decline }) {
      yield* Activity.make({ name: "reserve", execute: Effect.void }).pipe(
        Checkout.withCompensation(() => Activity.make({ name: "release", execute: Effect.void })),
      );
      return yield* Activity.make({
        name: "charge",
        success: Schema.String,
        error: Declined,
        execute: decline
          ? Effect.fail(new Declined({ reason: "card declined" }))
          : Effect.succeed("charged"),
      });
    }),
  ),
  Workflows.layer(
    Parent,
    Effect.fn(function* ({ id }) {
      const greeting = yield* Greet.execute({ id: `${id}-child`, name: "child" });
      return `parent got ${greeting}`;
    }),
  ),
);
