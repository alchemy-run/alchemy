import * as AI from "@alchemy.run/ai";
import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { LanguageModel } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { recording } from "../AI/fixtures/recording.ts";

// ---------------------------------------------------------------- a desk of tickets

class TicketOpened extends Domain.Event("TicketOpened", { subject: Schema.String }) {}
class TicketClosed extends Domain.Event("TicketClosed", { by: Schema.String }) {}

class OpenTicket extends Domain.Command("OpenTicket", {
  input: { ticketId: Schema.String, subject: Schema.String },
  events: [TicketOpened],
  rejects: [],
}) {}

class CloseTicket extends Domain.Command(
  "CloseTicket",
  { input: { ticketId: Schema.String, by: Schema.String }, events: [TicketClosed], rejects: [] },
  { description: "Close the ticket." },
) {}

class Ticket extends Domain.Aggregate("Ticket", {
  id: Schema.String,
  state: Schema.Struct({ open: Schema.Boolean }),
  initial: { open: false },
  commands: [OpenTicket, CloseTicket],
  keyOf: (command) => command.ticketId,
  decide: {
    OpenTicket: (_, command) => [new TicketOpened({ subject: command.subject })],
    CloseTicket: (_, command) => [new TicketClosed({ by: command.by })],
  },
  evolve: {
    TicketOpened: () => ({ open: true }),
    TicketClosed: () => ({ open: false }),
  },
}) {}

/** Looks after one ticket. */
class Helper extends AI.Process<Helper>()("Helper", {}) {}

/** What each session has said, and whether it is working: a view that follows the process. */
class Said extends Domain.View("Said", {
  from: [Helper],
  key: Schema.String,
  keyOf: { HelperActivity: ({ source }) => source.id },
  state: Schema.Struct({
    status: Schema.Literals(["idle", "working"]),
    said: Schema.Array(Schema.String),
  }),
  initial: { status: "idle", said: [] },
  evolve: {
    HelperActivity: (seen, event) => ({
      status: event.status,
      said: [
        ...seen.said,
        ...event.items.flatMap(({ item }) => (item.type === "tool" ? [] : [item.text])),
      ],
    }),
  },
}) {}

/** An opened ticket is handed to its Helper session. */
class Handover extends Domain.Policy("Handover", { from: Ticket, on: [TicketOpened] }) {}

const HandoverLive = Handover.toLayer(
  Effect.gen(function* () {
    const helper = yield* Helper;
    return Effect.fn(function* ({ source, event }) {
      yield* Match.valueTags(event, {
        TicketOpened: ({ subject }) => helper.get(source.id).send(subject, { requestId: "start" }),
      }).pipe(Effect.orDie);
    });
  }),
);

class Desk extends Domain.Model("Desk", {
  aggregates: [Ticket],
  views: [Said],
  policies: [Handover],
}) {}

/** What a page may read: the view the desk keeps of each Helper session. */
class DeskApi extends Domain.Api("DeskApi", { model: Desk, views: ["Helper"] }) {}

/** A Helper played by code: it closes its ticket, and says so. */
const HelperPlayed = AI.scripted(
  Helper,
  Effect.gen(function* () {
    const tickets = yield* Ticket;
    return Effect.fn(function* ({ key }: AI.Turn) {
      yield* tickets.send(new CloseTicket({ ticketId: key, by: "helper" }));
      return "Closed.";
    }, Effect.orDie);
  }),
);

/**
 * The desk in memory, with `helper` hosted beside it. The desk needs a
 * Helper for its policy and its view, and the Helper needs the desk.
 */
const deskWith = <E, R>(helper: Layer.Layer<Helper, E, R>) => {
  const DeskLive = Desk.layer(HandoverLive).pipe(Layer.provide(InMemory));
  const HelperHosted = AI.layerInMemory(helper.pipe(Layer.provide(DeskLive)));
  return DeskLive.pipe(Layer.provideMerge(HelperHosted));
};

describe("Domain: a process beside a model", { tags: ["unit", "local"] }, () => {
  // Recording batches by time, so this runs on the real clock.
  it.live("a policy reaches a session, and the model follows what it does", () =>
    Effect.gen(function* () {
      const tickets = yield* Ticket;
      const said = yield* Said;
      yield* tickets.send(new OpenTicket({ ticketId: "t-1", subject: "The printer is on fire" }));

      // The policy sent the subject, the session closed the ticket, and its
      // host recorded both of its items on the aggregate the view folds.
      const seen = yield* said.get("t-1").pipe(
        Effect.map(Option.getOrUndefined),
        Effect.repeat({
          schedule: Schedule.spaced("10 millis"),
          until: (seen) => seen?.status === "idle" && seen.said.length === 2,
          times: 200,
        }),
      );
      expect(seen).toEqual({ status: "idle", said: ["The printer is on fire", "Closed."] });
      expect(yield* tickets.get(Ticket.ref("t-1"))).toEqual({ open: false });
    }).pipe(Effect.provide(deskWith(HelperPlayed)), Effect.provide(RuntimeContext.phantom)),
  );

  it.effect("a client holds a session by its key, and waits for its answer", () =>
    Effect.gen(function* () {
      const helper = yield* Helper;
      const reply = yield* helper.get("t-2").prompt("Hello?");
      expect(reply.text).toBe("Closed.");

      // Each key is a session of its own.
      expect((yield* helper.get("t-2").history()).items).toHaveLength(2);
      expect((yield* helper.get("t-3").history()).items).toHaveLength(0);
    }).pipe(Effect.provide(deskWith(HelperPlayed)), Effect.provide(RuntimeContext.phantom)),
  );

  it.effect("a session's own tools reach the model its prose mentions", () =>
    Effect.suspend(() => {
      class Smart extends AI.Model<Smart>()("smart") {}
      const harness = recording();
      // The prose mentions a command of the model.
      const HelperLive = Helper.toLayer({ description: "Close one ticket." })`
        Close your ticket with ${Desk.CloseTicket}.
      `.pipe(
        Layer.provide(
          Layer.mergeAll(harness.layer, AI.DefaultModel(Smart)).pipe(
            Layer.provideMerge(
              Smart.layer(Layer.succeed(LanguageModel.LanguageModel, undefined as never)),
            ),
          ),
        ),
      );
      return Effect.gen(function* () {
        const helper = yield* Helper;
        const tickets = yield* Ticket;
        yield* tickets.send(new OpenTicket({ ticketId: "t-4", subject: "Stuck" }));
        // The policy's message reaches the harness inside the session's instance.
        yield* helper.get("t-4").send("Close it.");
        expect(harness.sessions.get("Helper/t-4")?.tools).toEqual(["Desk_CloseTicket_send"]);

        // The tool the mention gave is called there, and its command lands on the model.
        const sent = yield* harness.call(
          "Desk_CloseTicket_send",
          { input: { ticketId: "t-4", by: "helper" } },
          "call-1",
          "Helper/t-4",
        );
        expect(sent).toMatchObject({ isError: false });
        expect(yield* tickets.get(Ticket.ref("t-4"))).toEqual({ open: false });
      }).pipe(Effect.provide(deskWith(HelperLive)), Effect.provide(RuntimeContext.phantom));
    }),
  );

  it.live("the model serves each session as a view named after the process", () =>
    Effect.gen(function* () {
      const tickets = yield* Ticket;
      const api = yield* DeskApi.Client;
      yield* tickets.send(new OpenTicket({ ticketId: "t-5", subject: "Out of paper" }));

      // The view's state is where the session stands.
      const stands = yield* api.Helper.get("t-5").pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 millis"),
          until: (state) => state?.status === "idle" && state.queued.length === 0,
          times: 200,
        }),
      );
      expect(stands).toEqual({ status: "idle", queued: [] });

      // Its events carry the transcript, in order.
      const items = yield* api.Helper.events("t-5").pipe(
        Stream.takeWhile((entry) => "event" in entry),
        Stream.runCollect,
        Effect.map((entries) =>
          Array.from(entries).flatMap((entry) =>
            "event" in entry ? entry.event.items.map(({ item }) => item.type) : [],
          ),
        ),
      );
      expect(items).toEqual(["user", "assistant"]);
    }).pipe(
      Effect.provide(
        Layer.effect(DeskApi.Client, DeskApi.clientInProcess).pipe(
          Layer.provideMerge(deskWith(HelperPlayed)),
        ),
      ),
      Effect.provide(RuntimeContext.phantom),
    ),
  );

  it("a model whose view follows a process requires the process", () => {
    class Lonely extends Domain.Model("Lonely", { aggregates: [Ticket], views: [Said] }) {}
    const lonely = Lonely.layer(Layer.empty).pipe(Layer.provide(InMemory));
    // @ts-expect-error the model's view follows Helper, so its Layer needs one
    const complete: Layer.Layer<never, never, never> = lonely;
    void complete;
    expect(Lonely.views.map((view) => view.viewName)).toEqual(["Said", "Helper"]);
  });
});
