import { Command, Event, Rejection } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { CustomerId } from "../Customer/CustomerId.ts";

export class AlreadyOpen extends Rejection.make("AlreadyOpen") {}

export class AccountOpened extends Event.make("AccountOpened", {
  data: { customerId: CustomerId, owner: Schema.String },
}) {}

/** Open an account for a customer. */
export class OpenAccount extends Command.make("OpenAccount", {
  input: { customerId: CustomerId, owner: Schema.String },
  events: [AccountOpened],
  rejects: [AlreadyOpen],
}) {}
