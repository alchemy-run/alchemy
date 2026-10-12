import { Command, Event, Rejection } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { CustomerSession } from "../CustomerApi/CustomerSession.ts";
import { CustomerId } from "./CustomerId.ts";

export class AlreadyRegistered extends Rejection.make("AlreadyRegistered") {}

/** A customer may only register themselves. */
export class NotTheCustomer extends Rejection.make("NotTheCustomer") {}

export class CustomerRegistered extends Event.make("CustomerRegistered", {
  data: { name: Schema.String },
}) {}

/** Sign up as a customer; `MainAccountProvisioning` opens their main account. */
export class RegisterCustomer extends Command.make("RegisterCustomer", {
  target: CustomerId,
  input: { name: Schema.String },
  events: [CustomerRegistered],
  rejects: [AlreadyRegistered, NotTheCustomer],
}).middleware(CustomerSession) {}
