import { Policy } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import { Account, Freeze, MoneyWithdrawn } from "../Account/Account.ts";
import { system } from "../Actor.ts";
import { FraudCheck } from "./FraudCheck.ts";

/** Whenever a large withdrawal happens, score it and freeze the account if risky. */
export class FraudReview extends Policy.make("FraudReview", {
  from: Account,
  on: [MoneyWithdrawn],
}) {}

export const FraudReviewLive = FraudReview.toLayer(
  Effect.gen(function* () {
    const fraud = yield* FraudCheck;
    const accounts = yield* Account;
    return Effect.fn(function* ({ source, event }) {
      if (event.amount < 50_000) return;
      const { risk } = yield* fraud.score({ accountId: source.id, amount: event.amount });
      if (risk > 0.8) {
        yield* accounts
          .send(source, new Freeze({ reason: `fraud risk ${risk}`, by: system("FraudReview") }))
          .pipe(
            Effect.catchTag("NotOpen", () => Effect.void),
            Effect.catchTag("NotOwner", () => Effect.void),
          );
      }
    });
  }),
);
