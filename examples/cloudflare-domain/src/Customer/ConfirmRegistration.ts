import * as Domain from "alchemy/Domain";
import * as Schema from "effect/Schema";
import { CustomerId } from "./CustomerId.ts";
import { Username } from "./Username.ts";

export class CustomerRegistered extends Domain.Event("CustomerRegistered", {
  data: { name: Schema.String, username: Username },
}) {}

/** The username was claimed. Reports an outcome, so it never rejects. */
export class ConfirmRegistration extends Domain.Command("ConfirmRegistration", {
  target: CustomerId,
  events: [CustomerRegistered],
}) {}
