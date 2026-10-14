import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Activity, DurableClock, DurableDeferred, Workflow } from "effect/workflow";
import * as Workflows from "@/Workflows/index.ts";
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

export const WorkflowsLive = Layer.unwrap(
  Effect.gen(function* () {
    const journals = yield* Journal;
    // Right after a deploy, a call to the journal can fail in transit.
    const record = (id: string, entry: string) =>
      journals
        .getByName(id)
        .append(entry)
        .pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 20 }), Effect.orDie);

    const GreetLive = Workflows.layer(Greet, ({ id, name }) =>
      Effect.gen(function* () {
        const greeting = yield* Activity.make({
          name: "greet",
          success: Schema.String,
          execute: record(id, "greet").pipe(Effect.as(`hello ${name}`)),
        });
        yield* Activity.make({ name: "log", execute: record(id, "log") });
        return greeting;
      }),
    );

    const NapLive = Workflows.layer(Nap, ({ id, seconds }) =>
      Effect.gen(function* () {
        yield* Activity.make({ name: "before", execute: record(id, "before") });
        yield* DurableClock.sleep({
          name: "nap",
          duration: `${seconds} seconds`,
          inMemoryThreshold: 0,
        });
        yield* Activity.make({ name: "after", execute: record(id, "after") });
        return "rested";
      }),
    );

    const ApproveLive = Workflows.layer(Approve, ({ id }) =>
      Effect.gen(function* () {
        yield* Activity.make({ name: "requested", execute: record(id, "requested") });
        const by = yield* DurableDeferred.await(Approval);
        yield* Activity.make({ name: "approved", execute: record(id, `approved:${by}`) });
        return `approved by ${by}`;
      }),
    );

    const CheckoutLive = Workflows.layer(Checkout, ({ id, decline }) =>
      Effect.gen(function* () {
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
      }),
    );

    const ParentLive = Workflows.layer(Parent, ({ id }) =>
      Effect.gen(function* () {
        const greeting = yield* Greet.execute({ id: `${id}-child`, name: "child" });
        yield* Activity.make({ name: "parent", execute: record(id, `parent:${greeting}`) });
        return `parent got ${greeting}`;
      }),
    );

    return Layer.mergeAll(GreetLive, NapLive, ApproveLive, CheckoutLive, ParentLive);
  }),
);
