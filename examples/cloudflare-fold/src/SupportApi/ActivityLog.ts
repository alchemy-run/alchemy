import { Subscription } from "alchemy/Fold";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Account } from "../Account/Account.ts";
import { AccountActivity } from "../Account/AccountActivity.ts";
import { AccountId } from "../Account/AccountId.ts";
import { SupportAgentSession } from "./SupportAgentSession.ts";

/** Operational events on an account, live. */
export class ActivityLog extends Subscription.make("activity", {
  input: { accountId: AccountId },
  output: { at: Schema.String, kind: Schema.String, detail: Schema.String },
}).middleware(SupportAgentSession) {}

export const ActivityLogLive = ActivityLog.toLayer(
  Effect.gen(function* () {
    const activity = yield* AccountActivity;
    return Effect.fn(function* ({ accountId }) {
      return activity.tail(Account.ref(accountId)).pipe(
        Stream.map(({ event, envelope }) => ({
          at: DateTime.formatIso(envelope.at),
          kind: event._tag,
          detail: JSON.stringify(event),
        })),
      );
    });
  }),
);
