import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";

// A hold that expires an hour after it is placed, unless it is released first.
class HoldPlaced extends Domain.Event("HoldPlaced") {}
class HoldReleased extends Domain.Event("HoldReleased") {}
class HoldExpired extends Domain.Event("HoldExpired") {}

class PlaceHold extends Domain.Command("PlaceHold", {
  target: Schema.String,
  events: [HoldPlaced],
}) {}
class ReleaseHold extends Domain.Command("ReleaseHold", {
  target: Schema.String,
  events: [HoldReleased],
}) {}
/**
 * Records the expiry with no guard on state: only cancelling the schedule
 * keeps a released hold from expiring.
 */
class ExpireHold extends Domain.Command("ExpireHold", {
  target: Schema.String,
  events: [HoldExpired],
}) {}

class Hold extends Domain.Aggregate("Hold", {
  id: Schema.String,
  state: Schema.Struct({ status: Schema.Literals(["none", "held", "released", "expired"]) }),
  initial: { status: "none" },
  commands: [PlaceHold, ReleaseHold, ExpireHold],
  decide: {
    PlaceHold: () => [new HoldPlaced()],
    ReleaseHold: () => [new HoldReleased()],
    ExpireHold: () => [new HoldExpired()],
  },
  evolve: {
    HoldPlaced: () => ({ status: "held" as const }),
    HoldReleased: () => ({ status: "released" as const }),
    HoldExpired: () => ({ status: "expired" as const }),
  },
}) {}

/**
 * Wait until a hold's scheduled expiry has run. Its 20ms timer runs on the
 * real clock, which a loaded machine can push well past a fixed sleep.
 */
const untilExpired = <A extends { readonly status: string }, E, R>(get: Effect.Effect<A, E, R>) =>
  get.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("20 millis"),
      until: (hold) => hold.status === "expired",
      times: 250,
    }),
  );

/** The schedule key of a hold's expiry. */
const expiryOf = (id: string) => `expire:${id}`;

class HoldDeadline extends Domain.Policy("HoldDeadline", {
  from: Hold,
  on: [HoldPlaced, HoldReleased],
}) {}
const HoldDeadlineLive = HoldDeadline.toLayer(
  Effect.gen(function* () {
    const holds = yield* Hold;
    return Effect.fn(function* ({ source, event }) {
      if (event._tag === "HoldPlaced") {
        // a redelivery arms the same expiry again, which changes nothing
        yield* holds.schedule(source, new ExpireHold(), {
          after: "1 hour",
          commandId: expiryOf(source.id),
        });
      } else {
        yield* holds.unschedule(source, expiryOf(source.id)).pipe(
          // the hold expired first, and the release is recorded after it; a
          // redelivery, so the expiry is already cancelled; or the hold was
          // never placed, so there's no expiry
          Effect.catchTag(
            ["AlreadyExecuted", "AlreadyCancelled", "NotScheduled"],
            () => Effect.void,
          ),
        );
      }
    });
  }),
);

class Holds extends Domain.Model("Holds", {
  aggregates: [Hold],
  policies: [HoldDeadline],
}) {}

// A ticket that stalls an hour after it opens or resumes, unless it is paused.
// The stall timer keeps one id per ticket, so it fires as a stale no-op while
// the ticket is paused, then is armed again under that id on resume (#2804).
class TicketOpened extends Domain.Event("TicketOpened") {}
class TicketPaused extends Domain.Event("TicketPaused") {}
class TicketResumed extends Domain.Event("TicketResumed") {}
class TicketStalled extends Domain.Event("TicketStalled") {}

class OpenTicket extends Domain.Command("OpenTicket", {
  target: Schema.String,
  events: [TicketOpened],
}) {}
class PauseTicket extends Domain.Command("PauseTicket", {
  target: Schema.String,
  events: [TicketPaused],
}) {}
class ResumeTicket extends Domain.Command("ResumeTicket", {
  target: Schema.String,
  events: [TicketResumed],
}) {}
/** Records the stall only on an open ticket; on a paused one it records nothing. */
class MarkStalled extends Domain.Command("MarkStalled", {
  target: Schema.String,
  events: [TicketStalled],
}) {}

class Ticket extends Domain.Aggregate("Ticket", {
  id: Schema.String,
  state: Schema.Struct({ status: Schema.Literals(["none", "open", "paused", "stalled"]) }),
  initial: { status: "none" },
  commands: [OpenTicket, PauseTicket, ResumeTicket, MarkStalled],
  decide: {
    OpenTicket: () => [new TicketOpened()],
    PauseTicket: () => [new TicketPaused()],
    ResumeTicket: () => [new TicketResumed()],
    MarkStalled: (ticket) => (ticket.status === "open" ? [new TicketStalled()] : []),
  },
  evolve: {
    TicketOpened: () => ({ status: "open" as const }),
    TicketPaused: () => ({ status: "paused" as const }),
    TicketResumed: () => ({ status: "open" as const }),
    TicketStalled: () => ({ status: "stalled" as const }),
  },
}) {}

class StallTimer extends Domain.Policy("StallTimer", {
  from: Ticket,
  on: [TicketOpened, TicketResumed],
}) {}
/** Arms the stall timer under `stall:<id>`. */
const StallTimerLive = StallTimer.toLayer(
  Effect.gen(function* () {
    const tickets = yield* Ticket;
    return Effect.fn(function* ({ source }) {
      yield* tickets.schedule(source, new MarkStalled(), {
        after: "1 hour",
        commandId: `stall:${source.id}`,
      });
    });
  }),
);

class Tickets extends Domain.Model("Tickets", {
  aggregates: [Ticket],
  policies: [StallTimer],
}) {}

// A saga step that schedules a hold's expiry, does something to it, then fails
// its first attempt: the retry schedules the same arming again.
class Flaky extends Schema.TaggedError<Flaky>()("Flaky", {}) {}

class ArmExpiry extends Domain.Saga("ArmExpiry", {
  key: Schema.String,
  input: { then: Schema.Literals(["wait", "cancel"]) },
}) {}

const ArmExpiryLive = ArmExpiry.toLayer(
  Effect.gen(function* () {
    const holds = yield* Hold;
    return Effect.fn(function* ({ key, then }) {
      yield* Activity.make({
        name: "arm",
        error: Flaky,
        execute: Effect.gen(function* () {
          yield* holds.schedule(key, new ExpireHold(), { after: "20 millis", commandId: "x" });
          if ((yield* Activity.CurrentAttempt) > 1) return;
          if (then === "wait") yield* Effect.sleep("100 millis");
          else yield* holds.unschedule(key, "x").pipe(Effect.orDie);
          return yield* new Flaky();
        }),
      }).pipe(Activity.retry({ times: 2 }), Effect.orDie);
    });
  }),
);

class Arming extends Domain.Model("Arming", {
  aggregates: [Hold],
  sagas: [ArmExpiry],
}) {}
const ArmingLive = Arming.layer(ArmExpiryLive).pipe(Layer.provide(InMemory));

const t1 = Ticket.ref("t-1");
/** Open, pause before the hour, let the timer fire as a no-op, resume. */
const pausedThroughTheDeadline = [
  Story.clock("2026-01-01T00:00:00Z"),
  Story.when(t1, new OpenTicket()),
  Story.clock("2026-01-01T00:30:00Z"),
  Story.when(t1, new PauseTicket()),
  Story.clock("2026-01-01T01:00:00Z"),
  Story.then(t1, new TicketOpened(), new TicketPaused()),
  Story.when(t1, new ResumeTicket()),
  Story.then(t1, new TicketResumed()),
] as const;

const story = Story.make(Holds, { layer: HoldDeadlineLive });
const HoldsLive = Holds.layer(HoldDeadlineLive).pipe(Layer.provide(InMemory));
const h1 = Hold.ref("h-1");
const h2 = Hold.ref("h-2");

describe("Domain schedule", { tags: ["unit", "local"] }, () => {
  it.effect("a scheduled command fires when it is due", () =>
    story(
      Story.clock("2026-01-01T00:00:00Z"),
      Story.when(h1, new PlaceHold()),
      Story.then(h1, new HoldPlaced()),
      Story.clock("2026-01-01T01:00:00Z"),
      Story.then(h1, new HoldExpired()),
    ),
  );

  it.effect("an unscheduled command never fires", () =>
    story(
      Story.clock("2026-01-01T00:00:00Z"),
      Story.when(h1, new PlaceHold()),
      Story.when(h1, new ReleaseHold()),
      Story.then(h1, new HoldPlaced(), new HoldReleased()),
      Story.clock("2026-01-01T02:00:00Z"),
      Story.then(h1),
      Story.state(h1, (s) => expect(s.status).toBe("released")),
    ),
  );

  it.effect("unscheduling cancels only that instance's command", () =>
    story(
      Story.clock("2026-01-01T00:00:00Z"),
      Story.when(h1, new PlaceHold()),
      Story.when(h2, new PlaceHold()),
      Story.when(h1, new ReleaseHold()),
      Story.then(h1, new HoldPlaced(), new HoldReleased()),
      Story.then(h2, new HoldPlaced()),
      Story.clock("2026-01-01T01:00:00Z"),
      Story.then(h1),
      Story.then(h2, new HoldExpired()),
    ),
  );

  it.effect("a release after the command fired is still recorded", () =>
    story(
      Story.clock("2026-01-01T00:00:00Z"),
      Story.when(h1, new PlaceHold()),
      Story.clock("2026-01-01T01:00:00Z"),
      Story.then(h1, new HoldPlaced(), new HoldExpired()),
      Story.when(h1, new ReleaseHold()),
      Story.then(h1, new HoldReleased()),
    ),
  );

  it.live("an unscheduled command never fires on the real clock", () =>
    Effect.gen(function* () {
      const holds = yield* Hold;
      yield* holds.schedule("h-3", new ExpireHold(), { after: "20 millis", commandId: "x" });
      yield* holds.schedule("h-4", new ExpireHold(), { after: "20 millis", commandId: "x" });
      yield* holds.unschedule("h-3", "x");
      // Once h-4's timer has run, h-3's would have too.
      expect((yield* untilExpired(holds.get("h-4"))).status).toBe("expired");
      expect((yield* holds.get("h-3")).status).toBe("none");
    }).pipe(Effect.provide(HoldsLive)),
  );

  it.live("schedule returns the command id and when it is due, to cancel it by", () =>
    Effect.gen(function* () {
      const holds = yield* Hold;
      const before = yield* Effect.sync(() => Date.now());
      const receipt = yield* holds.schedule("h-9", new ExpireHold(), { after: "1 hour" });
      const at = DateTime.toEpochMillis(receipt.at);
      expect(at).toBeGreaterThanOrEqual(before + 3_600_000);
      expect(at).toBeLessThan(before + 3_600_000 + 1_000);
      yield* holds.unschedule("h-9", receipt.commandId);
      const fixed = yield* holds.schedule("h-9", new ExpireHold(), {
        at: DateTime.makeUnsafe("2030-01-01T00:00:00Z"),
        commandId: "x",
      });
      expect(fixed).toEqual({ commandId: "x", at: DateTime.makeUnsafe("2030-01-01T00:00:00Z") });
    }).pipe(Effect.provide(HoldsLive)),
  );

  it.live("unscheduling a command that ran fails with AlreadyExecuted", () =>
    Effect.gen(function* () {
      const holds = yield* Hold;
      yield* holds.schedule("h-5", new ExpireHold(), { after: "20 millis", commandId: "x" });
      yield* untilExpired(holds.get("h-5"));
      const error = yield* Effect.flip(holds.unschedule("h-5", "x"));
      expect(error).toEqual(
        new Domain.AlreadyExecuted({ aggregate: "Hold", id: "h-5", commandId: "x" }),
      );
    }).pipe(Effect.provide(HoldsLive)),
  );

  it.live("a schedule's id is its own: a command sent under the same id doesn't stop it", () =>
    Effect.gen(function* () {
      const holds = yield* Hold;
      yield* holds.send("h-6", new PlaceHold(), { commandId: "x" });
      yield* holds.schedule("h-6", new ExpireHold(), { after: "20 millis", commandId: "x" });
      expect((yield* untilExpired(holds.get("h-6"))).status).toBe("expired");
    }).pipe(Effect.provide(HoldsLive)),
  );

  it.live("unscheduling again fails with AlreadyCancelled, until it is scheduled again", () =>
    Effect.gen(function* () {
      const holds = yield* Hold;
      yield* holds.schedule("h-7", new ExpireHold(), { after: "1 hour", commandId: "x" });
      yield* holds.unschedule("h-7", "x");
      expect((yield* Effect.flip(holds.unschedule("h-7", "x")))._tag).toBe("AlreadyCancelled");
      yield* holds.schedule("h-7", new ExpireHold(), { after: "1 hour", commandId: "x" });
      yield* holds.unschedule("h-7", "x");
    }).pipe(Effect.provide(HoldsLive)),
  );

  it.live("unscheduling an id that was never scheduled fails with NotScheduled", () =>
    Effect.gen(function* () {
      const holds = yield* Hold;
      const error = yield* Effect.flip(holds.unschedule("h-8", "never"));
      expect(error).toEqual(
        new Domain.NotScheduled({ aggregate: "Hold", id: "h-8", commandId: "never" }),
      );
    }).pipe(Effect.provide(HoldsLive)),
  );

  it.live("scheduling again after the command ran arms it again", () =>
    Effect.gen(function* () {
      const holds = yield* Hold;
      yield* holds.schedule("h-10", new ExpireHold(), { after: "20 millis", commandId: "x" });
      yield* untilExpired(holds.get("h-10"));
      expect((yield* Effect.flip(holds.unschedule("h-10", "x")))._tag).toBe("AlreadyExecuted");
      const receipt = yield* holds.schedule("h-10", new ExpireHold(), {
        after: "1 hour",
        commandId: "x",
      });
      expect(receipt.commandId).toBe("x");
      // the new one is pending: it can be cancelled
      yield* holds.unschedule("h-10", "x");
    }).pipe(Effect.provide(HoldsLive)),
  );

  it.live("a step that runs again after its command ran leaves it as it ran", () =>
    Effect.gen(function* () {
      const arm = yield* ArmExpiry;
      const holds = yield* Hold;
      yield* (yield* arm.start("h-11", { then: "wait" })).result;
      expect((yield* untilExpired(holds.get("h-11"))).status).toBe("expired");
      expect((yield* Effect.flip(holds.unschedule("h-11", "x")))._tag).toBe("AlreadyExecuted");
    }).pipe(Effect.provide(ArmingLive)),
  );

  it.live("a step that runs again after it cancelled the command doesn't arm it again", () =>
    Effect.gen(function* () {
      const arm = yield* ArmExpiry;
      const holds = yield* Hold;
      yield* (yield* arm.start("h-12", { then: "cancel" })).result;
      yield* Effect.sleep("100 millis");
      expect((yield* holds.get("h-12")).status).toBe("none");
      expect((yield* Effect.flip(holds.unschedule("h-12", "x")))._tag).toBe("AlreadyCancelled");
    }).pipe(Effect.provide(ArmingLive)),
  );
});

describe("Domain schedule, armed again under the same id", { tags: ["unit", "local"] }, () => {
  it.effect("a timer that fired as a no-op fires again once armed again", () =>
    Story.make(Tickets, { layer: StallTimerLive })(
      ...pausedThroughTheDeadline,
      Story.clock("2026-01-01T02:00:00Z"),
      Story.then(t1, new TicketStalled()),
    ),
  );

  it.effect("a pending timer is replaced, not doubled", () =>
    Story.make(Tickets, { layer: StallTimerLive })(
      Story.clock("2026-01-01T00:00:00Z"),
      Story.when(t1, new OpenTicket()),
      Story.clock("2026-01-01T00:30:00Z"),
      Story.when(t1, new PauseTicket()),
      Story.when(t1, new ResumeTicket()),
      Story.then(t1, new TicketOpened(), new TicketPaused(), new TicketResumed()),
      // the first timer was due at 01:00; resuming replaced it with one due at 01:30
      Story.clock("2026-01-01T01:00:00Z"),
      Story.then(t1),
      Story.clock("2026-01-01T01:30:00Z"),
      Story.then(t1, new TicketStalled()),
    ),
  );
});
