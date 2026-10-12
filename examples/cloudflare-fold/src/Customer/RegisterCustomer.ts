import { Command, Event, Rejection } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { Session } from "../Session.ts";
import { CustomerId } from "./CustomerId.ts";
import { Username } from "./Username.ts";

/** The customer is registered, or a registration is already in progress. */
export class AlreadyRegistered extends Rejection.make("AlreadyRegistered") {}

/** A customer may only register themselves. */
export class NotTheCustomer extends Rejection.make("NotTheCustomer") {}

/** Registration waits for `UsernameReservation` to claim the username. */
export class RegistrationRequested extends Event.make("RegistrationRequested", {
  data: { name: Schema.String, username: Username },
}) {}

/**
 * Sign up as a customer under a unique username. The customer is registered
 * once the username is claimed; `MainAccountProvisioning` then opens their
 * main account.
 */
export class RegisterCustomer extends Command.make("RegisterCustomer", {
  target: CustomerId,
  middleware: [Session],
  input: { name: Schema.String, username: Username },
  events: [RegistrationRequested],
  rejects: [AlreadyRegistered, NotTheCustomer],
}) {}
