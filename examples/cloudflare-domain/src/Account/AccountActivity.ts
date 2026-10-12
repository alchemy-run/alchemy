import * as Domain from "alchemy/Domain";
import * as Effect from "effect/Effect";
import { CurrentActor } from "../CurrentActor.ts";
import { Forbidden } from "../Forbidden.ts";
import { Session } from "../Session.ts";
import { Account } from "./Account.ts";
import { OwnerChanged } from "./ChangeOwner.ts";
import { AccountClosed } from "./CloseAccount.ts";
import { AccountFrozen } from "./FreezeAccount.ts";
import { SettlementOnClosedAccount } from "./RecordSettlement.ts";
import { RefundStranded } from "./RefundTransfer.ts";

/** Operational events for support tooling, passed through unchanged. Agents only. */
export class AccountActivity extends Domain.View("AccountActivity", {
  from: [Account],
  key: Account,
  middleware: [Session],
  rejects: [Forbidden],
  validate: Effect.fn(function* (request) {
    const actor = yield* CurrentActor;
    if (actor._tag !== "Agent") {
      return yield* new Forbidden({ reason: `${request.mode} of account activity is for agents` });
    }
  }),
  events: [AccountFrozen, AccountClosed, OwnerChanged, RefundStranded, SettlementOnClosedAccount],
}) {}
