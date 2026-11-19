import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Thread } from "../Thread/Thread.aggregate.ts";
import { TaskClaimed } from "./ClaimTask.command.ts";
import { ExpireLease } from "./ExpireLease.command.ts";
import { LeaseRenewed } from "./RenewLease.command.ts";

/**
 * Whenever a task is claimed or its lease renewed, expire the claim when the
 * lease ends. Each claim has one deadline: a renewal schedules it again under
 * the same command id, which replaces it. The Thread decides the race, so a
 * claim completed or released in time records nothing when it fires.
 */
export class Leases extends Domain.Policy("Leases", {
  from: Thread,
  on: [TaskClaimed, LeaseRenewed],
}) {}

export const LeasesLive = Leases.toLayer(
  Effect.gen(function* () {
    const threads = yield* Thread;
    return Effect.fn(function* ({ source, event }) {
      yield* threads.schedule(new ExpireLease({ threadId: source.id, claim: event.claim }), {
        at: DateTime.makeUnsafe(event.leaseUntil),
        commandId: `lease:${event.claim}`,
      });
    });
  }),
);
