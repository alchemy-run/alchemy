import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { CustomerId } from "../CustomerId.ts";
import { Session } from "../Session.middleware.ts";
import { AccountId } from "./Account.id.ts";

/** The account id is taken. */
export class AlreadyOpen extends Domain.Rejection("AlreadyOpen", {}, { httpApiStatus: 409 }) {}

/** Only a signed-in customer opens an account, for themselves. */
export class NotACustomer extends Domain.Rejection("NotACustomer", {}, { httpApiStatus: 403 }) {}

export class AccountOpened extends Domain.Event("AccountOpened", {
  customerId: CustomerId,
  name: Schema.String,
}) {}

/** Open an account for the signed-in customer. The client picks its id. */
export class OpenAccount extends Domain.Command("OpenAccount", {
  target: AccountId,
  middleware: [Session],
  input: { name: Schema.String },
  events: [AccountOpened],
  rejects: [AlreadyOpen, NotACustomer],
}) {}
