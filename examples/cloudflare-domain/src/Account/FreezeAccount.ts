import * as Domain from "alchemy/Domain";
import * as Schema from "effect/Schema";
import { Actor } from "../Actor.ts";
import { Session } from "../Session.ts";
import { AccountId } from "./AccountId.ts";
import { NotOpen } from "./NotOpen.ts";
import { NotOwner } from "./NotOwner.ts";

export class AccountFrozen extends Domain.Event("AccountFrozen", {
  data: { reason: Schema.String, by: Actor },
}) {}

/** Stop money leaving an account. Freezing a frozen account records nothing. */
export class FreezeAccount extends Domain.Command("FreezeAccount", {
  target: AccountId,
  middleware: [Session],
  input: { reason: Schema.String },
  events: [AccountFrozen],
  rejects: [NotOpen, NotOwner],
}) {}
