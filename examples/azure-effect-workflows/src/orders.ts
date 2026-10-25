import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity, DurableClock, DurableDeferred, Workflow } from "effect/workflow";

/** The charge was declined; the reservation is released. */
export class Declined extends Schema.TaggedError<Declined>()("Declined", {
  reason: Schema.String,
}) {}

/** Who approved an order, sent from outside with the run's `signal`. */
export const Approval = DurableDeferred.make("approval", { success: Schema.String });

/** Reserve stock, wait for approval, cool off, then charge. */
export const PlaceOrder = Workflow.make("PlaceOrder", {
  payload: { orderId: Schema.String, quantity: Schema.Number },
  success: Schema.String,
  error: Declined,
  idempotencyKey: ({ orderId }) => orderId,
});

export const PlaceOrderLive = Workflows.layer(
  PlaceOrder,
  Effect.fn(function* ({ orderId, quantity }) {
    yield* Activity.make({
      name: "reserve",
      execute: Effect.log(`reserved ${quantity} for ${orderId}`),
    }).pipe(
      PlaceOrder.withCompensation(() =>
        Activity.make({ name: "release", execute: Effect.log(`released ${orderId}`) }),
      ),
    );
    const approvedBy = yield* DurableDeferred.await(Approval);
    // A durable timer: nothing runs, or is billed, while it waits.
    yield* DurableClock.sleep({ name: "cool-off", duration: "2 seconds", inMemoryThreshold: 0 });
    return yield* Activity.make({
      name: "charge",
      success: Schema.String,
      error: Declined,
      execute:
        quantity > 5
          ? Effect.fail(new Declined({ reason: `${quantity} is over the limit of 5` }))
          : Effect.succeed(`charged ${orderId}, approved by ${approvedBy}`),
    });
  }),
);
