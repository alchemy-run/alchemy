import { Command, Event, Rejection } from "alchemy/Fold";
import * as Schema from "effect/Schema";

export class AlreadyRegistered extends Rejection.make("AlreadyRegistered") {}

export class CustomerRegistered extends Event.make("CustomerRegistered", {
  data: { name: Schema.String },
}) {}

/** Sign up as a customer; `MainAccountProvisioning` opens their main account. */
export class Register extends Command.make("Register", {
  input: { name: Schema.String },
  events: [CustomerRegistered],
  rejects: [AlreadyRegistered],
}) {}
