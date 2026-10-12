import { Command, Event, Rejection } from "alchemy/Fold";
import { Actor } from "../Actor.ts";
import { CustomerId } from "../Customer/CustomerId.ts";
import { Session } from "../Session.ts";
import { AccountId } from "./AccountId.ts";
import { NotOpen } from "./NotOpen.ts";

/** Only support agents may reassign accounts. */
export class NotPermitted extends Rejection.make("NotPermitted") {}

export class OwnerChanged extends Event.make("OwnerChanged", {
  data: { previous: CustomerId, customerId: CustomerId, by: Actor },
}) {}

/** Reassign an account to another customer. */
export class ChangeOwner extends Command.make("ChangeOwner", {
  target: AccountId,
  middleware: [Session],
  input: { customerId: CustomerId },
  events: [OwnerChanged],
  rejects: [NotOpen, NotPermitted],
}) {}
