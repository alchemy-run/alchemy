import * as Domain from "alchemy/Domain";
import { Actor } from "../Actor.ts";
import { CustomerId } from "../Customer/CustomerId.ts";
import { Session } from "../Session.ts";
import { AccountId } from "./AccountId.ts";
import { NotOpen } from "./NotOpen.ts";

/** Only support agents may reassign accounts. */
export class NotPermitted extends Domain.Rejection("NotPermitted") {}

export class OwnerChanged extends Domain.Event("OwnerChanged", {
  previous: CustomerId,
  customerId: CustomerId,
  by: Actor,
}) {}

/** Reassign an account to another customer. */
export class ChangeOwner extends Domain.Command("ChangeOwner", {
  target: AccountId,
  middleware: [Session],
  input: { customerId: CustomerId },
  events: [OwnerChanged],
  rejects: [NotOpen, NotPermitted],
}) {}
