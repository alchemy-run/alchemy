import { Command, Event } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { Actor } from "../Actor.ts";
import { SupportAgentSession } from "../SupportApi/SupportAgentSession.ts";
import { AccountId } from "./AccountId.ts";
import { NotOpen } from "./NotOpen.ts";
import { NotOwner } from "./NotOwner.ts";

export class AccountFrozen extends Event.make("AccountFrozen", {
  data: { reason: Schema.String, by: Actor },
}) {}

/** Stop money leaving an account. Freezing a frozen account records nothing. */
export class FreezeAccount extends Command.make("FreezeAccount", {
  target: AccountId,
  input: { reason: Schema.String },
  events: [AccountFrozen],
  rejects: [NotOpen, NotOwner],
}).middleware(SupportAgentSession) {}
