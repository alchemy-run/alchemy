import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { AccountId } from "./Account.id.ts";

export class AlreadyOpen extends Domain.Rejection("AlreadyOpen") {}
export class AccountOpened extends Domain.Event("AccountOpened", { owner: Schema.String }) {}

export class OpenAccount extends Domain.Command("OpenAccount", {
  target: AccountId,
  input: { owner: Schema.String },
  events: [AccountOpened],
  rejects: [AlreadyOpen],
}) {}
