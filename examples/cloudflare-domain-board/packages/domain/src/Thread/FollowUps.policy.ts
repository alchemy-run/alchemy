import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { DeliverFollowUp } from "./DeliverFollowUp.command.ts";
import { FollowUpScheduled } from "./ScheduleFollowUp.command.ts";
import { Thread } from "./Thread.aggregate.ts";

/** Whenever someone schedules a follow-up, post it in its thread when it is due. */
export class FollowUps extends Domain.Policy("FollowUps", {
  from: Thread,
  on: [FollowUpScheduled],
}) {}

export const FollowUpsLive = FollowUps.toLayer(
  Effect.gen(function* () {
    const threads = yield* Thread;
    return Effect.fn(function* ({ source, event }) {
      yield* threads.schedule(
        new DeliverFollowUp({
          threadId: source.id,
          followUpId: event.followUpId,
          text: event.text,
          by: event.by,
        }),
        { at: DateTime.makeUnsafe(event.at), commandId: `follow-up:${event.followUpId}` },
      );
    });
  }),
);
