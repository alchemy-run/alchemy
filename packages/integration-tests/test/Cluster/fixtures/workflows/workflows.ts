import * as Cluster from "@alchemy.run/effect-cluster";
/** The shared workflow engine conformance workflows, as Cluster.Workflow declarations. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DurableDeferred } from "effect/workflow";
import { Journal } from "./journal.ts";

export class Declined extends Schema.TaggedError<Declined>()("Declined", {
  reason: Schema.String,
}) {}

/** Two activities and a result. */
export class Greet extends Cluster.Workflow<Greet>()("Greet", {
  payload: { id: Schema.String, name: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
}) {}

/** Sleeps durably between two activities. */
export class Nap extends Cluster.Workflow<Nap>()("Nap", {
  payload: { id: Schema.String, seconds: Schema.Number },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
}) {}

/** Waits for someone outside to approve it. */
export const Approval = DurableDeferred.make("approval", { success: Schema.String });

export class Approve extends Cluster.Workflow<Approve>()("Approve", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
}) {}

/** Reserves, then charges; a declined charge releases the reservation. */
export class Checkout extends Cluster.Workflow<Checkout>()("Checkout", {
  payload: { id: Schema.String, decline: Schema.Boolean },
  success: Schema.String,
  error: Declined,
  idempotencyKey: ({ id }) => id,
}) {}

/** Runs Greet as a child workflow. */
export class Parent extends Cluster.Workflow<Parent>()("Parent", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
}) {}

/** Appends an entry to a run's journal, which is how the tests see what ran. */
export const Recorder = Effect.gen(function* () {
  const journals = yield* Journal;
  return (id: string, entry: string) =>
    journals.getByName(id).pipe(
      Effect.flatMap((journal) => journal.Append({ entry })),
      Effect.orDie,
    );
});
