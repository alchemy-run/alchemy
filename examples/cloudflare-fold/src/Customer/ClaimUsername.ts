import { Command, Event, Rejection } from "alchemy/Fold";
import { CustomerId } from "./CustomerId.ts";
import { Username } from "./Username.ts";

/** Someone else holds this username. */
export class UsernameTaken extends Rejection.make("UsernameTaken") {}

export class UsernameClaimed extends Event.make("UsernameClaimed", {
  data: { customerId: CustomerId },
}) {}

/**
 * Reserve a username for a customer. Sent by `UsernameReservation`; claiming
 * a username the customer already holds records nothing.
 */
export class ClaimUsername extends Command.make("ClaimUsername", {
  target: Username,
  input: { customerId: CustomerId },
  events: [UsernameClaimed],
  rejects: [UsernameTaken],
}) {}
