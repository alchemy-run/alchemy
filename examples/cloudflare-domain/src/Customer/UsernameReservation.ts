import * as Domain from "alchemy/Domain";
import * as Effect from "effect/Effect";
import { ClaimUsername } from "./ClaimUsername.ts";
import { ConfirmRegistration } from "./ConfirmRegistration.ts";
import { Customer } from "./Customer.ts";
import { RegistrationRequested } from "./RegisterCustomer.ts";
import { RejectRegistration } from "./RejectRegistration.ts";
import { UsernameClaim } from "./UsernameClaim.ts";

/**
 * Reserve first, then commit: claim the username, and only then register the
 * customer. Nothing downstream (the main account) happens for a registration
 * whose username is taken.
 */
export class UsernameReservation extends Domain.Policy("UsernameReservation", {
  from: Customer,
  on: [RegistrationRequested],
}) {}

export const UsernameReservationLive = UsernameReservation.toLayer(
  Effect.gen(function* () {
    const claims = yield* UsernameClaim;
    const customers = yield* Customer;
    return Effect.fn(function* ({ source, event }) {
      yield* claims.send(event.username, new ClaimUsername({ customerId: source.id })).pipe(
        Effect.andThen(customers.send(source, new ConfirmRegistration())),
        Effect.catchTag("UsernameTaken", () =>
          customers.send(source, new RejectRegistration({ reason: "username taken" })),
        ),
      );
    });
  }),
);
