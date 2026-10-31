import * as Domain from "@alchemy.run/domain";
import * as InMemory from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

class Submitted extends Domain.Event("Submitted") {}
class Approved extends Domain.Event("Approved") {}
class Cancelled extends Domain.Event("Cancelled") {}
class Noted extends Domain.Event("Noted", { text: Schema.String }) {}
class Reminded extends Domain.Event("Reminded") {}

class TooLate extends Domain.Rejection("TooLate") {}

class Submit extends Domain.Command("Submit", {
  target: Schema.String,
  events: [Submitted],
  rejects: [Domain.WrongPhase],
}) {}
class Approve extends Domain.Command("Approve", {
  target: Schema.String,
  events: [Approved],
  rejects: [Domain.WrongPhase, TooLate],
  reply: { status: Schema.String },
}) {}
class Cancel extends Domain.Command("Cancel", {
  target: Schema.String,
  events: [Cancelled],
  rejects: [Domain.WrongPhase],
}) {}
class Note extends Domain.Command("Note", {
  target: Schema.String,
  input: { text: Schema.String },
  events: [Noted],
}) {}
// Declares no rejections, so it can be scheduled, and can't be refused.
class Remind extends Domain.Command("Remind", { target: Schema.String, events: [Reminded] }) {}

const Status = Schema.Literals(["draft", "submitted", "approved", "cancelled"]);
const State = Schema.Struct({ status: Status, notes: Schema.Number, reminders: Schema.Number });
type State = typeof State.Type;

class Order extends Domain.Aggregate("Order", {
  id: Schema.String,
  state: State,
  initial: { status: "draft", notes: 0, reminders: 0 },
  commands: [Submit, Approve, Cancel, Note, Remind],
  decide: {
    Submit: () => [new Submitted()],
    Approve: () => [new Approved()],
    Cancel: () => [new Cancelled()],
    Note: (_, cmd) => [new Noted({ text: cmd.text })],
    Remind: () => [new Reminded()],
  },
  evolve: {
    Submitted: (s) => ({ ...s, status: "submitted" as const }),
    Approved: (s) => ({ ...s, status: "approved" as const }),
    Cancelled: (s) => ({ ...s, status: "cancelled" as const }),
    Noted: (s) => ({ ...s, notes: s.notes + 1 }),
    Reminded: (s) => ({ ...s, reminders: s.reminders + 1 }),
  },
  reply: { Approve: (s) => ({ status: s.status }) },
  phases: {
    draft: { on: { Submitted: "submitted", Cancelled: "cancelled" } },
    submitted: { on: { Approved: "approved", Cancelled: "cancelled" } },
    approved: {},
    cancelled: {},
  },
  phaseOf: (s) => s.status,
  when: {
    Submit: ["draft"],
    Approve: ["submitted"],
    Cancel: ["draft", "submitted"],
    Note: "*",
    Remind: ["submitted"],
  },
}) {}

class Shop extends Domain.Model("Shop", { aggregates: [Order] }) {}
class OrdersApi extends Domain.Api("OrdersApi", Approve) {}
const ShopLayer = Shop.layer(Layer.empty).pipe(Layer.provide(InMemory.InMemory));

const status = (status: State["status"]): State => ({ status, notes: 0, reminders: 0 });

describe("Aggregate phases", () => {
  it.effect("the host refuses a command outside its phases, before decide", () =>
    Effect.gen(function* () {
      const orders = yield* Order;
      const refused = yield* orders.send("o-1", new Approve()).pipe(Effect.flip);
      expect(refused).toBeInstanceOf(Domain.WrongPhase);
      expect(refused).toMatchObject({
        command: "Approve",
        phase: "draft",
        allowed: ["submitted"],
      });
      expect(yield* orders.state("o-1")).toEqual(status("draft"));
    }).pipe(Effect.provide(ShopLayer)),
  );

  it.effect("a command runs in its phases, and moves the instance", () =>
    Effect.gen(function* () {
      const orders = yield* Order;
      yield* orders.send("o-1", new Submit());
      const { reply } = yield* orders.send("o-1", new Approve());
      expect(reply).toEqual({ status: "approved" });
      yield* orders.send("o-1", new Note({ text: "any phase" }));
      expect(yield* orders.state("o-1")).toEqual({ ...status("approved"), notes: 1 });
    }).pipe(Effect.provide(ShopLayer)),
  );

  it.effect("a command with no rejections records nothing outside its phases", () =>
    Effect.gen(function* () {
      const orders = yield* Order;
      const receipt = yield* orders.send("o-1", new Remind());
      expect(receipt).toMatchObject({ version: 0, events: [] });
      yield* orders.send("o-1", new Submit());
      yield* orders.send("o-1", new Remind());
      expect((yield* orders.state("o-1")).reminders).toBe(1);
    }).pipe(Effect.provide(ShopLayer)),
  );

  it.live("an Api client gets the typed rejection", () =>
    Effect.gen(function* () {
      const orders = yield* OrdersApi.clientInProcess;
      const refused = yield* orders.Approve("o-1", {}).pipe(Effect.flip);
      expect(refused).toBeInstanceOf(Domain.WrongPhase);
      if (refused._tag === "WrongPhase") expect(refused.allowed).toEqual(["submitted"]);
    }).pipe(Effect.scoped, Effect.provide(ShopLayer)),
  );

  it("the class reads the phase and the next commands", () => {
    expect(Order.phase(status("draft"))).toBe("draft");
    expect(Order.nextCommands(status("draft"))).toEqual(["Submit", "Cancel", "Note"]);
    expect(Order.nextCommands(status("submitted"))).toEqual([
      "Approve",
      "Cancel",
      "Note",
      "Remind",
    ]);
    expect(Order.nextCommands(status("approved"))).toEqual(["Note"]);
  });

  it("an aggregate with no phases keeps every command", () => {
    expect(Plain.phase({ n: 0 })).toBeUndefined();
    expect(Plain.nextCommands({ n: 0 })).toEqual(["Bump"]);
    expect(Domain.verify(PlainModel)).toEqual([]);
  });

  it("predict gives what the host gives", () => {
    const options = { id: "o-1", now: DateTime.makeUnsafe(0) };
    expect(Order.predict(status("draft"), new Approve(), options)).toMatchObject({
      _tag: "Rejected",
      rejection: { _tag: "WrongPhase", phase: "draft" },
    });
    expect(Order.predict(status("draft"), new Remind(), options)).toMatchObject({
      _tag: "Accepted",
      events: [],
    });
    expect(Order.predict(status("submitted"), new Approve(), options)).toMatchObject({
      _tag: "Accepted",
      state: { status: "approved" },
    });
  });

  it.effect("a move phases does not declare is a defect, and nothing commits", () =>
    Effect.gen(function* () {
      const tickets = yield* Ticket;
      const exit = yield* Effect.exit(tickets.send("t-1", new Skip()));
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
        "'Skipped' moved an instance from 'open' to 'done'",
      );
      expect(yield* tickets.state("t-1")).toEqual({ phase: "open" });
    }).pipe(Effect.provide(Tickets.layer(Layer.empty).pipe(Layer.provide(InMemory.InMemory)))),
  );

  it("predict reports an undeclared move as Unpredictable", () => {
    const outcome = Ticket.predict({ phase: "open" }, new Skip(), {
      id: "t-1",
      now: DateTime.makeUnsafe(0),
    });
    expect(outcome._tag).toBe("Unpredictable");
  });
});

class Bumped extends Domain.Event("Bumped") {}
class Bump extends Domain.Command("Bump", { target: Schema.String, events: [Bumped] }) {}
class Plain extends Domain.Aggregate("Plain", {
  id: Schema.String,
  state: Schema.Struct({ n: Schema.Number }),
  initial: { n: 0 },
  commands: [Bump],
  decide: { Bump: () => [new Bumped()] },
  evolve: { Bumped: (s) => ({ n: s.n + 1 }) },
}) {}
class PlainModel extends Domain.Model("PlainModel", { aggregates: [Plain] }) {}

class Skipped extends Domain.Event("Skipped") {}
class Skip extends Domain.Command("Skip", { target: Schema.String, events: [Skipped] }) {}
class Closed extends Domain.Event("Closed") {}
class Close extends Domain.Command("Close", { target: Schema.String, events: [Closed] }) {}
class Ticket extends Domain.Aggregate("Ticket", {
  id: Schema.String,
  state: Schema.Struct({ phase: Schema.Literals(["open", "done"]) }),
  initial: { phase: "open" },
  commands: [Skip, Close],
  decide: { Skip: () => [new Skipped()], Close: () => [new Closed()] },
  evolve: {
    Skipped: () => ({ phase: "done" as const }),
    Closed: () => ({ phase: "done" as const }),
  },
  // `Skipped` moves an instance too, but only `Closed` may.
  phases: { open: { on: { Closed: "done" } }, done: {} },
  phaseOf: (s) => s.phase,
  when: { Skip: "*", Close: "*" },
}) {}
class Tickets extends Domain.Model("Tickets", { aggregates: [Ticket] }) {}

/** A Ticket-shaped aggregate with its phase table replaced. */
const withTable = (table: Partial<Domain.Aggregate.Any["definition"]>) => {
  const broken = Object.create(Broken) as Domain.Aggregate.Any;
  Object.defineProperty(broken, "definition", { value: { ...Broken.definition, ...table } });
  return class extends Domain.Model("Broken", { aggregates: [broken] }) {};
};

class Started extends Domain.Event("Started") {}
class Finished extends Domain.Event("Finished") {}
class Start extends Domain.Command("Start", { target: Schema.String, events: [Started] }) {}
class Finish extends Domain.Command("Finish", {
  target: Schema.String,
  events: [Finished],
  rejects: [TooLate],
}) {}
class Broken extends Domain.Aggregate("Job", {
  id: Schema.String,
  state: Schema.Struct({ phase: Schema.Literals(["idle", "busy", "over"]) }),
  initial: { phase: "idle" },
  commands: [Start, Finish],
  decide: { Start: () => [new Started()], Finish: () => [new Finished()] },
  evolve: {
    Started: () => ({ phase: "busy" as const }),
    Finished: () => ({ phase: "over" as const }),
  },
}) {}

const good = {
  phases: { idle: { on: { Started: "busy" } }, busy: { on: { Finished: "over" } }, over: {} },
  phaseOf: (s: { readonly phase: string }) => s.phase,
  when: { Start: ["idle"], Finish: "*" },
} as unknown as Partial<Domain.Aggregate.Any["definition"]>;
const messages = (table: object) =>
  Domain.verify(
    withTable({ ...good, ...(table as Partial<Domain.Aggregate.Any["definition"]>) }),
  ).map((problem) => problem.message);

describe("Domain.verify on phases", () => {
  it("passes a complete table", () => {
    expect(Domain.verify(Shop)).toEqual([]);
  });

  it("finds a phase no move reaches", () => {
    expect(
      messages({
        phases: { idle: { on: { Started: "busy" } }, busy: {}, over: {} },
      }),
    ).toEqual(["Job: no move reaches phase 'over'"]);
  });

  it("finds a command with no phase", () => {
    expect(messages({ when: { Start: ["idle"], Finish: [] } })).toEqual(
      expect.arrayContaining(["Job: Finish runs in no phase: add it to when"]),
    );
    expect(messages({ when: { Start: ["idle"] } })).toEqual(
      expect.arrayContaining(["Job: Finish runs in no phase: add it to when"]),
    );
  });

  it("finds a move no event can make", () => {
    expect(messages({ when: { Start: ["idle"], Finish: ["idle"] } })).toEqual(
      expect.arrayContaining([
        "Job: no command that runs in 'busy' records 'Finished', so that move can never happen",
      ]),
    );
  });

  it("finds names that do not exist", () => {
    expect(
      messages({
        phases: {
          idle: { on: { Started: "busy", Nope: "over" } },
          busy: { on: { Finished: "gone" } },
          over: {},
        },
        when: { Start: ["idle", "lost"], Finish: "*", Ghost: "*" },
      }),
    ).toEqual(
      expect.arrayContaining([
        "Job.when.Ghost is not a command of Job",
        "Job.when.Start names unknown phase 'lost'",
        "Job.phases.idle.on.Nope is not an event of Job",
        "Job.phases.busy.on.Finished names unknown phase 'gone'",
      ]),
    );
  });

  it("finds an initial state outside the phases", () => {
    expect(messages({ phaseOf: () => "limbo" })).toEqual([
      "Job.phaseOf(initial) is 'limbo', which is not in phases",
    ]);
  });

  it("finds half a table", () => {
    expect(messages({ when: undefined })).toEqual([
      "Job must declare phases, phaseOf and when together",
    ]);
  });

  it("finds a command that could be refused but does not declare WrongPhase", () => {
    expect(messages({ when: { Start: ["idle"], Finish: ["busy"] } })).toEqual([
      "Job: Finish can run outside its phases, so it must declare Domain.WrongPhase in rejects (or declare no rejections, and record nothing there)",
    ]);
  });
});

// Types: `phases` names the phases, and every other field must use those names.
class TypedOrder extends Domain.Aggregate("TypedOrder", {
  id: Schema.String,
  state: State,
  initial: { status: "draft", notes: 0, reminders: 0 },
  commands: [Submit],
  decide: { Submit: () => [new Submitted()] },
  evolve: { Submitted: (s) => s },
  phases: {
    draft: { on: { Submitted: "submitted" } },
    submitted: {},
    approved: {},
    cancelled: {},
  },
  phaseOf: (s) => s.status,
  when: { Submit: ["draft"] },
}) {}
const phase: "draft" | "submitted" | "approved" | "cancelled" = TypedOrder.phase(status("draft"));
const next: ReadonlyArray<"Submit"> = TypedOrder.nextCommands(status("draft"));
const none: undefined = Plain.phase({ n: 0 });
void [phase, next, none];

export const typeChecks = () => {
  Domain.Aggregate("Typo", {
    id: Schema.String,
    state: State,
    initial: { status: "draft", notes: 0, reminders: 0 },
    commands: [Submit],
    decide: { Submit: () => [new Submitted()] },
    evolve: { Submitted: (s) => s },
    phases: { draft: {}, submitted: {}, approved: {}, cancelled: {} },
    phaseOf: (s) => s.status,
    // @ts-expect-error `drafts` is not a phase
    when: { Submit: ["drafts"] },
  });
  Domain.Aggregate("Missing", {
    id: Schema.String,
    state: State,
    initial: { status: "draft", notes: 0, reminders: 0 },
    commands: [Submit],
    decide: { Submit: () => [new Submitted()] },
    evolve: { Submitted: (s) => s },
    phases: { draft: {} },
    // @ts-expect-error a state can be in a phase `phases` does not list
    phaseOf: (s) => s.status,
    when: { Submit: ["draft"] },
  });
  Domain.Aggregate("BadEvent", {
    id: Schema.String,
    state: State,
    initial: { status: "draft", notes: 0, reminders: 0 },
    commands: [Submit],
    decide: { Submit: () => [new Submitted()] },
    evolve: { Submitted: (s) => s },
    phases: {
      draft: {
        on: {
          // @ts-expect-error `Approved` is not an event of this aggregate
          Approved: "submitted",
        },
      },
      submitted: {},
      approved: {},
      cancelled: {},
    },
    phaseOf: (s) => s.status,
    when: { Submit: ["draft"] },
  });
};
