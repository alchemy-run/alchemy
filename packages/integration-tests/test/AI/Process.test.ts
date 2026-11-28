import * as AI from "@alchemy.run/ai";
import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { LanguageModel } from "effect/ai";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as App from "./fixtures/chat/App.ts";
import { Chat, follow } from "./fixtures/chat/Client.ts";
import { ChatHandlers } from "./fixtures/chat/Handlers.ts";
import { ChatRpcs } from "./fixtures/chat/Rpcs.ts";
import { recording } from "./fixtures/recording.ts";

class Fast extends AI.Model<Fast>()("fast") {}
class Smart extends AI.Model<Smart>()("smart") {}

/** No test here reaches a model. */
const never = Layer.succeed(LanguageModel.LanguageModel, undefined as never);
const ModelsLive = Layer.mergeAll(Fast.layer(never), Smart.layer(never));

class Add extends AI.Tool<Add>()("add", {
  description: "Add two integers.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Struct({ sum: Schema.Number }),
}) {}
const AddLive = Add.make(({ a, b }) => ({ sum: a + b }));

class Research extends (AI.Process<Research>()("Research", {
  description: "Answer one question about the code.",
})`
  Answer the question with ${Add}.
  If it is too broad, start a ${AI.Self} on ${Fast} for each part.
`) {}

class Releasing extends (AI.Process<Releasing>()("Releasing", {
  description: "How to cut a release.",
})`
  Add the version numbers with ${Add}, then tag the commit.
`) {}

class Engineer extends AI.Process<Engineer>()("Engineer", {}) {}

const EngineerLive = Engineer.toLayer({
  description: "Implement one task.",
})`
  Implement the task you are given.
  Start a ${Research} for what you need to know. When asked to ship, follow ${Releasing}.
`;

/** Run with a recording harness, as an instance that has a runtime context. */
const run = <A, E>(
  effect: (
    harness: ReturnType<typeof recording>,
  ) => Effect.Effect<
    A,
    E,
    AI.Harness | AI.DefaultModel | Fast | Smart | Add | Engineer | RuntimeContext
  >,
) =>
  Effect.suspend(() => {
    const harness = recording();
    return effect(harness).pipe(
      Effect.provide(
        EngineerLive.pipe(
          Layer.provideMerge(
            Layer.mergeAll(harness.layer, AI.DefaultModel(Smart), AddLive, RuntimeContext.phantom),
          ),
          Layer.provideMerge(ModelsLive),
        ),
      ),
    );
  });

describe("AI.Process", { tags: ["unit"] }, () => {
  it.effect("steers and interrupts the session it names", () =>
    run((harness) =>
      Effect.gen(function* () {
        const session = (yield* Research).get("q1");
        yield* session.send("Where is the parser?");
        yield* session.steer("Only look in src.");
        yield* session.interrupt;

        const recorded = harness.sessions.get("Research/q1")!;
        expect(recorded.messages).toEqual([
          { text: "Where is the parser?", model: "smart" },
          { text: "Only look in src.", model: "smart", steered: true },
        ]);
        expect(recorded.interrupts).toBe(1);
      }),
    ),
  );

  it.effect("reports its status, then its items after a seq", () =>
    run(() =>
      Effect.gen(function* () {
        const session = (yield* Research).get("q1");
        yield* session.send("one");
        yield* session.send("two");
        yield* session.send("three");

        const events = yield* Stream.runCollect(session.events({ after: 1 }));
        expect(Array.from(events)).toEqual([
          { type: "status", status: "idle", queued: [] },
          { type: "item", seq: 2, item: { type: "user", text: "two" } },
          { type: "item", seq: 3, item: { type: "user", text: "three" } },
        ]);
      }),
    ),
  );

  it.effect("pages its history in either order", () =>
    run(() =>
      Effect.gen(function* () {
        const session = (yield* Research).get("q1");
        yield* session.send("one");
        yield* session.send("two");
        yield* session.send("three");

        const first = yield* session.history({ take: 2 });
        expect(first.items.map((entry) => entry.seq)).toEqual([1, 2]);
        expect(first.next).toBe(2);
        const rest = yield* session.history({ take: 2, after: first.next! });
        expect(rest.items.map((entry) => entry.seq)).toEqual([3]);
        expect(rest.next).toBeUndefined();

        const newest = yield* session.history({ take: 2, order: "desc" });
        expect(newest.items.map((entry) => entry.seq)).toEqual([3, 2]);
      }),
    ),
  );

  it.effect("serves a session as an RPC group a user defines", () =>
    run((harness) =>
      Effect.gen(function* () {
        const session = (yield* Research).get("q1");
        const client = yield* RpcTest.makeClient(ChatRpcs).pipe(
          Effect.provide(ChatHandlers(session)),
        );
        yield* client.send({ text: "one", requestId: "a" });
        yield* client.send({ text: "one", requestId: "a" });
        yield* client.steer({ text: "two", requestId: "b" });
        yield* client.interrupt();

        expect(
          harness.sessions.get("Research/q1")!.messages.map((message) => message.text),
        ).toEqual(["one", "two"]);
        expect(harness.sessions.get("Research/q1")!.interrupts).toBe(1);
        // The session's own Schemas cross the wire unchanged.
        const events = yield* follow({ after: 1 }).pipe(
          Stream.provideService(Chat, client),
          Stream.runCollect,
        );
        expect(Array.from(events)).toEqual([
          { type: "status", status: "idle", queued: [] },
          { type: "item", seq: 2, item: { type: "user", text: "two" } },
        ]);
        expect((yield* client.history({ take: 1, order: "desc" })).items).toEqual([
          { seq: 2, item: { type: "user", text: "two" } },
        ]);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("a Foldkit Model is built from a session's events", () =>
    Effect.sync(() => {
      const events: ReadonlyArray<AI.SessionEvent> = [
        {
          type: "status",
          status: "working",
          queued: [{ id: "7", text: "next", delivery: "queue" }],
        },
        { type: "item", seq: 1, item: { type: "user", text: "one" } },
        { type: "status", status: "idle", queued: [] },
      ];
      const model = events.reduce(
        (model, event) => App.update(model, App.Message.ReceivedSessionEvent({ event })).model,
        App.init({ page: "p" }).model,
      );
      expect(model.status).toBe("idle");
      expect(model.queued).toEqual([]);
      expect(model.items).toEqual([{ seq: 1, item: { type: "user", text: "one" } }]);

      // Each click is one Command, named so a retry is not run twice.
      const sent = App.update({ ...model, draft: "two" }, App.Message.ClickedSend());
      expect(sent.model.sent).toBe(1);
      expect(sent.commands?.map((command) => command.name)).toEqual(["Send"]);
    }),
  );

  it.effect("a session nobody started is idle and empty", () =>
    run(() =>
      Effect.gen(function* () {
        const session = (yield* Research).get("nobody");
        const events = yield* Stream.runCollect(session.events());
        expect(Array.from(events)).toEqual([{ type: "status", status: "idle", queued: [] }]);
        expect(yield* session.history()).toEqual({ items: [] });
      }),
    ),
  );

  it.effect("is told what to do in the messages it is sent", () =>
    run((harness) =>
      Effect.gen(function* () {
        const research = yield* Research;
        yield* research.get("q1").send("Where is the parser?");

        expect(harness.sessions.get("Research/q1")!.messages).toEqual([
          { text: "Where is the parser?", model: "smart" },
        ]);
      }),
    ),
  );

  it.effect("renders each mention as the model reads it", () =>
    run((harness) =>
      Effect.gen(function* () {
        const research = yield* Research;
        yield* research.get("q1").send("x");

        const { instructions } = harness.sessions.get("Research/q1")!;
        expect(instructions).toContain(
          "Answer the question with `rec_add`.\nIf it is too broad, start a Research on `fast` for each part.",
        );
        expect(instructions).toContain("- Research: Answer one question about the code.");
      }),
    ),
  );

  it.effect("starts on the model its starter names", () =>
    run((harness) =>
      Effect.gen(function* () {
        const research = yield* Research;
        yield* research.start("q1", { model: Fast });
        yield* research.get("q1").send("x");

        expect(harness.sessions.get("Research/q1")!.messages[0]!.model).toBe("fast");
      }),
    ),
  );

  it.effect("does nothing when the key already started", () =>
    run((harness) =>
      Effect.gen(function* () {
        const research = yield* Research;
        yield* research.start("q1", { model: Fast });
        yield* research.start("q1", { model: Smart });
        yield* research.get("q1").send("x");

        expect(harness.sessions.get("Research/q1")!.messages[0]!.model).toBe("fast");
      }),
    ),
  );

  it.effect("sends and prompts a session", () =>
    run((harness) =>
      Effect.gen(function* () {
        const engineer = yield* Engineer;
        yield* engineer.get("t1").send("Rename the flag.", { requestId: "c-1" });
        yield* engineer.get("t1").send("Rename the flag.", { requestId: "c-1" });
        const reply = yield* engineer.get("t1").prompt("Done?");

        expect(reply.text).toBe("echo: Done?");
        expect(harness.sessions.get("Engineer/t1")!.messages.map((each) => each.text)).toEqual([
          "Rename the flag.",
          "Done?",
        ]);
      }),
    ),
  );

  it.effect("opens the harness once, with what every process mentions", () =>
    run((harness) =>
      Effect.gen(function* () {
        const engineer = yield* Engineer;
        yield* engineer.get("t1").send("x");
        yield* engineer.get("t2").send("y");

        expect(harness.opened).toHaveLength(1);
        expect(harness.opened[0]!.models.toSorted()).toEqual(["fast", "smart"]);
        expect(harness.opened[0]!.tools.toSorted()).toEqual([
          "add",
          "follow_engineer",
          "send_releasing",
          "send_research",
          "start_releasing",
          "start_research",
        ]);
      }),
    ),
  );

  it.effect("gives a session the tools of the processes it may follow", () =>
    run((harness) =>
      Effect.gen(function* () {
        const engineer = yield* Engineer;
        yield* engineer.get("t1").send("x");

        expect(harness.sessions.get("Engineer/t1")!.tools).toContain("add");
      }),
    ),
  );

  it.effect("follows a process by reading its prose", () =>
    run((harness) =>
      Effect.gen(function* () {
        const engineer = yield* Engineer;
        yield* engineer.get("t1").send("x");

        const followed = yield* harness.call("follow_engineer", { process: "Releasing" });
        expect(followed.structured).toEqual({
          instructions: "Add the version numbers with `rec_add`, then tag the commit.",
        });
      }),
    ),
  );

  it.effect("starts a process as a session of its own", () =>
    run((harness) =>
      Effect.gen(function* () {
        const engineer = yield* Engineer;
        yield* engineer.get("t1").send("x");

        const named = yield* harness.call("start_research", {
          text: "Where is the parser?",
          session: "parser",
          model: "fast",
        });
        expect(named.structured).toEqual({ session: "parser" });
        expect(harness.sessions.get("Research/parser")!.messages).toEqual([
          { text: "Where is the parser?", requestId: "start", model: "fast" },
        ]);

        // Without a name, the session is named after the call, so a replayed call starts nothing new.
        const unnamed = yield* harness.call("start_research", { text: "y" }, "call-7");
        expect(unnamed.structured).toEqual({ session: "call-7" });
        expect(harness.sessions.has("Research/call-7")).toBe(true);
      }),
    ),
  );

  it.effect("sends a message to a session it started", () =>
    run((harness) =>
      Effect.gen(function* () {
        const engineer = yield* Engineer;
        yield* engineer.get("t1").send("x");
        yield* harness.call("start_research", { text: "q", session: "s" });

        const sent = yield* harness.call("send_research", { session: "s", text: "Narrow it." });
        expect(sent.structured).toEqual({ sent: true });
        const refused = yield* harness.call("send_research", { session: "nope", text: "?" });
        expect(refused.structured).toEqual({ sent: false });
        expect(harness.sessions.has("Research/nope")).toBe(false);
        expect(harness.sessions.get("Research/s")!.messages.map((each) => each.text)).toEqual([
          "q",
          "Narrow it.",
        ]);
      }),
    ),
  );

  it.effect("mentioning a command behind no middleware needs no start", () =>
    Effect.suspend(() => {
      class Noted extends Domain.Event("Noted", { text: Schema.String }) {}
      class Note extends Domain.Command("Note", {
        input: { id: Schema.String, text: Schema.String },
        events: [Noted],
        rejects: [],
      }) {}
      class Pad extends Domain.Aggregate("Pad", {
        id: Schema.String,
        state: Schema.Struct({ notes: Schema.Number }),
        initial: { notes: 0 },
        commands: [Note],
        keyOf: (command) => command.id,
        decide: { Note: (_, command) => [new Noted({ text: command.text })] },
        evolve: { Noted: (pad) => ({ notes: pad.notes + 1 }) },
      }) {}
      class Pads extends Domain.Model("Pads", { aggregates: [Pad] }) {}
      class Scribe extends (AI.Process<Scribe>()("Scribe", { description: "Take notes." })`
        Write each thing you are told with ${Pads.Note}.
      `) {}
      const harness = recording();
      return Effect.gen(function* () {
        const scribe = yield* Scribe;
        // Nothing it mentions asks who is calling, so it acts as nobody.
        yield* scribe.get("a").send("Remember the milk.");
        expect(harness.sessions.get("Scribe/a")!.messages).toEqual([
          { text: "Remember the milk.", model: "smart" },
        ]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(harness.layer, AI.DefaultModel(Smart), RuntimeContext.phantom).pipe(
            Layer.provideMerge(Layer.mergeAll(ModelsLive, Pads.layer(Layer.empty))),
            Layer.provideMerge(InMemory),
            Layer.provideMerge(SecureRandom.layerWebCrypto),
          ),
        ),
      );
    }),
  );

  it.effect("a session that acts as nobody needs no start", () =>
    Effect.suspend(() => {
      class Chat extends (AI.Process<Chat>()("Chat", { description: "Talk." })`
        Answer in one sentence.
      `) {}
      const harness = recording();
      return Effect.gen(function* () {
        const chat = yield* Chat;
        const reply = yield* chat.get("a").prompt("Hello");

        expect(reply.text).toBe("echo: Hello");
        expect(harness.sessions.get("Chat/a")!.instructions).toBe("Answer in one sentence.");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(harness.layer, AI.DefaultModel(Smart), RuntimeContext.phantom).pipe(
            Layer.provideMerge(ModelsLive),
          ),
        ),
      );
    }),
  );
});
