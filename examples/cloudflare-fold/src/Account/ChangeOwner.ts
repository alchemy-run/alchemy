import { Command, Event, Rejection } from "alchemy/Fold";
import { Actor } from "../Actor.ts";
import { CustomerId } from "../Customer/CustomerId.ts";
import { NotOpen } from "./NotOpen.ts";

/** Only support agents may reassign accounts. */
export class NotPermitted extends Rejection.make("NotPermitted") {}

export class OwnerChanged extends Event.make("OwnerChanged", {
  data: { previous: CustomerId, customerId: CustomerId, by: Actor },
}) {}

/** Reassign an account to another customer. */
export class ChangeOwner extends Command.make("ChangeOwner", {
  input: { customerId: CustomerId, by: Actor },
  events: [OwnerChanged],
  rejects: [NotOpen, NotPermitted],
}) {}
