import { Command, Event } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { CustomerId } from "./CustomerId.ts";
import { Username } from "./Username.ts";

export class CustomerRegistered extends Event.make("CustomerRegistered", {
  data: { name: Schema.String, username: Username },
}) {}

/** The username was claimed. Reports an outcome, so it never rejects. */
export class ConfirmRegistration extends Command.make("ConfirmRegistration", {
  target: CustomerId,
  events: [CustomerRegistered],
}) {}
