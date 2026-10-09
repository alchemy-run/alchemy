import { Mutation } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import { Account, ChangeOwner, NotOpen, NotPermitted } from "../Account/Account.ts";
import { AccountId } from "../Account/AccountId.ts";
import { agent } from "../Actor.ts";
import { CustomerId } from "../Customer/CustomerId.ts";
import { CurrentAgent } from "./CurrentAgent.ts";
import { SupportAgentSession } from "./SupportAgentSession.ts";

/** Move an account to another customer. */
export class ReassignAccount extends Mutation.make("reassign", {
  input: { accountId: AccountId, customerId: CustomerId },
  errors: [NotOpen, NotPermitted],
}).middleware(SupportAgentSession) {}

export const ReassignAccountLive = ReassignAccount.toLayer(
  Effect.gen(function* () {
    const accounts = yield* Account;
    return Effect.fn(function* ({ accountId, customerId }) {
      const { agentId } = yield* CurrentAgent;
      yield* accounts.send(accountId, new ChangeOwner({ customerId, by: agent(agentId) }));
    });
  }),
);
