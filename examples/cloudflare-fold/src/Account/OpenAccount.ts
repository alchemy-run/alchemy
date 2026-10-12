import { Command, Event, Rejection } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { CustomerId } from "../Customer/CustomerId.ts";
import { AccountId } from "./AccountId.ts";

export class AlreadyOpen extends Rejection.make("AlreadyOpen") {}

export class AccountOpened extends Event.make("AccountOpened", {
  data: { customerId: CustomerId, owner: Schema.String },
}) {}

/** Open an account for a customer. Sent by `MainAccountProvisioning`. */
export class OpenAccount extends Command.make("OpenAccount", {
  target: AccountId,
  input: { customerId: CustomerId, owner: Schema.String },
  events: [AccountOpened],
  rejects: [AlreadyOpen],
}) {}
