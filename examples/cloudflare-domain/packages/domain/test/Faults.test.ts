import * as Explore from "@alchemy.run/domain/Explore";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Booking, BookingApi } from "./fixtures/Booking.model.ts";
import { Booth, BoothApi } from "./fixtures/Booth.model.ts";
import { Tally, TallyApi } from "./fixtures/Tally.model.ts";
import { Tickets, TicketsApi } from "./fixtures/Ticket.model.ts";

// The kernel delivers an event to a policy at least once, and runs the
// reactions that wait at the same time in no set order. Each model here keeps
// its rule when every event is handled once and in the order written, and
// breaks it otherwise.

const tags = (story: ReadonlyArray<Explore.Step> | undefined) =>
  story?.map((step) => [step.by, (step.command as { _tag: string })._tag]);

const tally = (faults: { readonly reorder: boolean }) =>
  Explore.report(Tally, {
    source: new URL("./fixtures/Tally.model.ts", import.meta.url),
    apis: [TallyApi],
    depth: 1,
    faults: { redeliver: false, ...faults },
  });

it.effect(
  "two reactions to one event run in either order",
  () =>
    Effect.gen(function* () {
      const written = yield* tally({ reorder: false });
      expect(written.rules).toMatchObject([{ name: "AnOpenRoundScoresTwo", broken: undefined }]);
      const any = yield* tally({ reorder: true });
      // The bonus first: nothing doubled is nothing, and the point makes one.
      expect(tags(any.rules[0]?.broken)).toEqual([
        [undefined, "OpenRound"],
        ["Bonus", "Double"],
        ["Award", "AddOne"],
      ]);
      expect(any.disagreements).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

const tickets = (faults: { readonly redeliver: boolean }) =>
  Explore.report(Tickets, {
    source: new URL("./fixtures/Ticket.model.ts", import.meta.url),
    apis: [TicketsApi],
    depth: 1,
    faults: { reorder: false, ...faults },
  });

it.effect(
  "an event delivered twice is handled twice, and only the kernel's command ids make that safe",
  () =>
    Effect.gen(function* () {
      const once = yield* tickets({ redeliver: false });
      expect(once.rules).toMatchObject([{ name: "OneTicketPerSeat", broken: undefined }]);
      expect(once.repeated).toEqual([]);
      const twice = yield* tickets({ redeliver: true });
      const story = twice.rules[0]?.broken;
      expect(tags(story)).toEqual([
        [undefined, "BookSeat"],
        ["Issue", "IssueTicket"],
        ["Issue", "IssueTicket"],
      ]);
      expect(story?.map((step) => step.again)).toEqual([false, false, true]);
      // The two tickets are two instances: the solver picks a second number.
      expect(new Set(story?.slice(1).map((step) => step.id)).size).toBe(2);
      expect(twice.repeated).toEqual(["Numbers.next, by Issue"]);
      expect(Explore.render(twice)).toContain("↳ Issue, handling its event again: Ticket");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a command a policy sent once is not run again when its event comes again",
  () =>
    Effect.gen(function* () {
      // Award's AddOne goes to the same score both times: the score takes it once.
      const report = yield* Explore.report(Tally, {
        source: new URL("./fixtures/Tally.model.ts", import.meta.url),
        apis: [TallyApi],
        depth: 1,
        faults: { redeliver: true, reorder: false },
      });
      expect(report.rules).toMatchObject([{ name: "AnOpenRoundScoresTwo", broken: undefined }]);
      expect(report.rules[0]?.states).toBeGreaterThan(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

const booth = (faults: { readonly rerun: boolean }) =>
  Explore.report(Booth, {
    source: new URL("./fixtures/Booth.model.ts", import.meta.url),
    apis: [BoothApi],
    depth: 1,
    faults: { redeliver: false, reorder: false, ...faults },
  });

it.effect(
  "a saga's step written with the library's functions is searched as the plain one is",
  () =>
    Effect.gen(function* () {
      // `Effect.all`, `Effect.forEach`, `Effect.result`, `filterOrFail`, `catch`, and a stream run to its head.
      const once = yield* booth({ rerun: false });
      expect(once.rules).toMatchObject([{ name: "OneTicketPerSeat", broken: undefined }]);
      const twice = yield* booth({ rerun: true });
      const story = twice.rules[0]?.broken;
      expect(tags(story)).toEqual([
        [undefined, "BookSeat"],
        ["Stamping", "IssueTicket"],
        ["Stamping", "IssueTicket"],
      ]);
      expect(twice.repeated).toEqual(["Numbers.next, by Stamping in its step issue"]);
      expect(twice.disagreements).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

const booking = (faults: { readonly rerun: boolean }) =>
  Explore.report(Booking, {
    source: new URL("./fixtures/Booking.model.ts", import.meta.url),
    apis: [BookingApi],
    depth: 1,
    faults: { redeliver: false, reorder: false, ...faults },
  });

it.effect(
  "a saga that stops after a step and before its result is kept runs the step again",
  () =>
    Effect.gen(function* () {
      const once = yield* booking({ rerun: false });
      expect(once.rules).toMatchObject([{ name: "OneTicketPerSeat", broken: undefined }]);
      const twice = yield* booking({ rerun: true });
      const story = twice.rules[0]?.broken;
      expect(tags(story)).toEqual([
        [undefined, "BookSeat"],
        ["Ticketing", "IssueTicket"],
        ["Ticketing", "IssueTicket"],
      ]);
      expect(story?.map((step) => [step.step, step.again])).toEqual([
        [undefined, false],
        ["issue", false],
        ["issue", true],
      ]);
      expect(new Set(story?.slice(1).map((step) => step.id)).size).toBe(2);
      expect(twice.repeated).toEqual(["Numbers.next, by Ticketing in its step issue"]);
      expect(Explore.render(twice)).toContain("↳ Ticketing, running its step issue again: Ticket");
      expect(twice.disagreements).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
