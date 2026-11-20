import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Session } from "../Session.middleware.ts";
import { CustomerId } from "./Customer.id.ts";
import { Username } from "./Username.ts";

/** The customer is already registered. */
export class AlreadyRegistered extends Domain.Rejection("AlreadyRegistered") {}

/** A customer may only register themselves. */
export class NotTheCustomer extends Domain.Rejection("NotTheCustomer") {}

/** Someone else holds this username. */
export class UsernameTaken extends Domain.Rejection("UsernameTaken") {}

export class CustomerRegistered extends Domain.Event("CustomerRegistered", {
  name: Schema.String,
  username: Username,
}) {}

export class UsernameClaimed extends Domain.Event("UsernameClaimed", { customerId: CustomerId }) {}

/**
 * Sign up as a customer under a unique username. It involves the customer
 * and the username, so `Registration` decides it across both;
 * `MainAccountProvisioning` then opens the customer's main account.
 */
export class RegisterCustomer extends Domain.Command("RegisterCustomer", {
  middleware: [Session],
  input: { customerId: CustomerId, name: Schema.String, username: Username },
  events: [CustomerRegistered, UsernameClaimed],
  rejects: [AlreadyRegistered, NotTheCustomer, UsernameTaken],
}) {}
