import { Policy } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import { Account, Freeze } from "../Account/Account.ts";
import { system } from "../Actor.ts";
import { DailyOutflow, DailyOutflowExceeded } from "./DailyOutflow.ts";
import { FraudCheck } from "./FraudCheck.ts";

/** Whenever an account's daily outflow crosses the threshold, score it and freeze the account if risky. */
export class FraudReview extends Policy.make("FraudReview", {
  from: DailyOutflow,
  on: [DailyOutflowExceeded],
}) {}

export const FraudReviewLive = FraudReview.toLayer(
  Effect.gen(function* () {
    const fraud = yield* FraudCheck;
    const accounts = yield* Account;
    return Effect.fn(function* ({ source, event }) {
      const { risk } = yield* fraud.score({ accountId: source.id, amount: event.total });
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
