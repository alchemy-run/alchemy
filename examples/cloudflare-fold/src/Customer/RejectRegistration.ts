import { Command, Event } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { CustomerId } from "./CustomerId.ts";
import { Username } from "./Username.ts";

/** The registration failed; the customer may register again. */
export class RegistrationRejected extends Event.make("RegistrationRejected", {
  data: { username: Username, reason: Schema.String },
}) {}

/** The username could not be claimed. Reports an outcome, so it never rejects. */
export class RejectRegistration extends Command.make("RejectRegistration", {
  target: CustomerId,
  input: { reason: Schema.String },
  events: [RegistrationRejected],
}) {}
