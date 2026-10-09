import { Mutation } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Account, Freeze, NotOpen } from "../Account/Account.ts";
import { AccountId } from "../Account/AccountId.ts";
import { agent } from "../Actor.ts";
import { CurrentAgent } from "./CurrentAgent.ts";
import { SupportAgentSession } from "./SupportAgentSession.ts";

/** Freeze any account. */
export class FreezeAccount extends Mutation.make("freeze", {
  input: { accountId: AccountId, reason: Schema.String },
  errors: [NotOpen],
}).middleware(SupportAgentSession) {}

export const FreezeAccountLive = FreezeAccount.toLayer(
  Effect.gen(function* () {
    const accounts = yield* Account;
    return Effect.fn(function* ({ accountId, reason }) {
      const { agentId } = yield* CurrentAgent;
      yield* accounts
        .send(accountId, new Freeze({ reason, by: agent(agentId) }))
        .pipe(Effect.catchTag("NotOwner", () => Effect.die("agents may act on any account")));
    });
  }),
);
