import * as AI from "@alchemy.run/ai";
import { makeHarness } from "@alchemy.run/ai/Harness";
import { describe, expect, it } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { LanguageModel } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/** What a recording harness was asked to run. */
interface Recorded {
  readonly instructions: string;
  readonly tools: ReadonlyArray<string>;
  readonly messages: Array<{
    readonly text: string;
    readonly requestId?: string;
    readonly model?: string;
  }>;
}

/** An `AI.Harness` that runs nothing: it keeps what each session was given. */
const recording = () => {
  const sessions = new Map<string, Recorded>();
  const handlers = new Map<string, (parameters: unknown) => Effect.Effect<unknown, unknown, any>>();
  const opened: Array<{ models: ReadonlyArray<string>; tools: ReadonlyArray<string> }> = [];
  const toolName = (tool: unknown) => (tool as { toolName: string }).toolName;
  const layer = makeHarness<never>("recording", (options) =>
    Effect.sync(() => {
      opened.push({
        models: options.models.map((model) => model.modelName),
        tools: options.tools.map(toolName),
      });
      for (const tool of options.tools) {
        const handler = (tool as { handler?: (parameters: unknown) => Effect.Effect<unknown> })
          .handler;
        if (handler !== undefined) handlers.set(toolName(tool), handler);
      }
      return {
        toolName: (tool) => `rec_${toolName(tool)}`,
        session: (name, options) => {
          const record = () => {
            let session = sessions.get(name);
            if (session === undefined) {
              session = {
                instructions: options.instructions,
                tools: options.tools.map(toolName),
                messages: [],
              };
              sessions.set(name, session);
            }
            return session;
          };
          const submit = (text: string, sent?: AI.SendOptions) =>
            Effect.sync(() => {
              const session = record();
              if (sent?.requestId !== undefined) {
                if (session.messages.some((message) => message.requestId === sent.requestId)) {
                  return;
                }
              }
              session.messages.push({
                text,
                ...(sent?.requestId === undefined ? {} : { requestId: sent.requestId }),
                model: (sent?.model ?? options.model).modelName,
              });
            });
          return {
            exists: Effect.sync(() => sessions.has(name)),
            submit,
            prompt: (text, sent) => Effect.as(submit(text, sent), { text: `echo: ${text}` }),
            wait: Effect.void,
            abort: Effect.void,
            messages: Effect.sync(() => sessions.get(name)?.messages ?? []),
          };
        },
      };
    }),
  );
  /** Call a tool the way a harness does, as one call of a conversation. */
  const call = (name: string, parameters: unknown, callId = "call-1") =>
    handlers.get(name)!(parameters).pipe(
      Effect.provideService(AI.ToolCall, { conversationId: "c", callId }),
    );
  return { layer, sessions, opened, call };
};

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

const question = AI.Input("question", Schema.String);
const depth = AI.Input("depth", Schema.optionalKey(Schema.Number));

class Research extends (AI.Process<Research>()("Research", {
  description: "Answer one question about the code.",
})`
  Answer ${question} to ${depth} levels with ${Add}.
  If it is too broad, start a ${AI.Self} on ${Fast} for each part.
`) {}

class Releasing extends (AI.Process<Releasing>()("Releasing", {
  description: "How to cut a release.",
})`
  Add the version numbers with ${Add}, then tag the commit.
`) {}

const task = AI.Input("task", Schema.String);

class Engineer extends AI.Process<Engineer>()("Engineer", { inputs: [task] }) {}

const EngineerLive = Engineer.toLayer({
  description: "Implement one task.",
})`
  You are implementing ${task}.
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
  it.effect("starts a session with its inputs as the first message", () =>
    run((harness) =>
      Effect.gen(function* () {
        const research = yield* Research;
        yield* research.start("q1", { question: "Where is the parser?", depth: 2 });

        const session = harness.sessions.get("Research/q1")!;
        expect(session.messages).toEqual([
          {
            text: "question: Where is the parser?\ndepth: 2",
            requestId: "start",
            model: "smart",
          },
        ]);
      }),
    ),
  );

  it.effect("renders each mention as the model reads it", () =>
    run((harness) =>
      Effect.gen(function* () {
        const research = yield* Research;
        yield* research.start("q1", { question: "x" });

        const { instructions } = harness.sessions.get("Research/q1")!;
        expect(instructions).toContain(
          "Answer `question` to `depth` levels with `rec_add`.\nIf it is too broad, start a Research on `fast` for each part.",
        );
        expect(instructions).toContain(
          "Your first message gives a value for each input: `question`, `depth`.",
        );
        expect(instructions).toContain("- Research: Answer one question about the code.");
      }),
    ),
  );

  it.effect("does nothing when the key already started", () =>
    run((harness) =>
      Effect.gen(function* () {
        const research = yield* Research;
        yield* research.start("q1", { question: "first" });
        yield* research.start("q1", { question: "second" });

        expect(harness.sessions.get("Research/q1")!.messages.map((each) => each.text)).toEqual([
          "question: first",
        ]);
      }),
    ),
  );

  it.effect("starts on the model its starter names", () =>
    run((harness) =>
      Effect.gen(function* () {
        const research = yield* Research;
        yield* research.start("q1", { question: "x" }, { model: Fast });

        expect(harness.sessions.get("Research/q1")!.messages[0]!.model).toBe("fast");
      }),
    ),
  );

  it.effect("refuses a message to a session that never started", () =>
    run(() =>
      Effect.gen(function* () {
        const research = yield* Research;
        const error = yield* Effect.flip(research.get("nope").send("hello"));

        expect(error).toMatchObject({ _tag: "NotStarted", process: "Research", key: "nope" });
      }),
    ),
  );

  it.effect("sends and prompts a started session", () =>
    run((harness) =>
      Effect.gen(function* () {
        const engineer = yield* Engineer;
        yield* engineer.start("t1", { task: "Rename the flag" });
        yield* engineer.get("t1").send("Also the docs.", { requestId: "c-1" });
        yield* engineer.get("t1").send("Also the docs.", { requestId: "c-1" });
        const reply = yield* engineer.get("t1").prompt("Done?");

        expect(reply.text).toBe("echo: Done?");
        expect(harness.sessions.get("Engineer/t1")!.messages.map((each) => each.text)).toEqual([
          "task: Rename the flag",
          "Also the docs.",
          "Done?",
        ]);
      }),
    ),
  );

  it.effect("opens the harness once, with what every process mentions", () =>
    run((harness) =>
      Effect.gen(function* () {
        const engineer = yield* Engineer;
        yield* engineer.start("t1", { task: "x" });
        yield* engineer.start("t2", { task: "y" });

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
        yield* engineer.start("t1", { task: "x" });

        expect(harness.sessions.get("Engineer/t1")!.tools).toContain("add");
      }),
    ),
  );

  it.effect("follows a process by reading its prose", () =>
    run((harness) =>
      Effect.gen(function* () {
        const engineer = yield* Engineer;
        yield* engineer.start("t1", { task: "x" });

        const followed = yield* harness.call("follow_engineer", { process: "Releasing" });
        expect(followed).toEqual({
          instructions: "Add the version numbers with `rec_add`, then tag the commit.",
        });
      }),
    ),
  );

  it.effect("starts a process as a session of its own", () =>
    run((harness) =>
      Effect.gen(function* () {
        const engineer = yield* Engineer;
        yield* engineer.start("t1", { task: "x" });

        const named = yield* harness.call("start_research", {
          input: { question: "Where is the parser?" },
          session: "parser",
          model: "fast",
        });
        expect(named).toEqual({ session: "parser" });
        expect(harness.sessions.get("Research/parser")!.messages).toEqual([
          { text: "question: Where is the parser?", requestId: "start", model: "fast" },
        ]);

        // Without a name, the session is named after the call, so a replayed call starts nothing new.
        const unnamed = yield* harness.call(
          "start_research",
          { input: { question: "y" } },
          "call-7",
        );
        expect(unnamed).toEqual({ session: "call-7" });
        expect(harness.sessions.has("Research/call-7")).toBe(true);
      }),
    ),
  );

  it.effect("sends a message to a session it started", () =>
    run((harness) =>
      Effect.gen(function* () {
        const engineer = yield* Engineer;
        yield* engineer.start("t1", { task: "x" });
        yield* harness.call("start_research", { input: { question: "q" }, session: "s" });

        expect(yield* harness.call("send_research", { session: "s", text: "Narrow it." })).toEqual({
          sent: true,
        });
        expect(yield* harness.call("send_research", { session: "nope", text: "?" })).toEqual({
          sent: false,
        });
        expect(harness.sessions.get("Research/s")!.messages.map((each) => each.text)).toEqual([
          "question: q",
          "Narrow it.",
        ]);
      }),
    ),
  );

  it.effect("a process without inputs needs no start", () =>
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

  it.effect("refuses prose that mentions an input its tag does not list", () =>
    Effect.suspend(() => {
      const harness = recording();
      const Wrong = Engineer.toLayer({ description: "Wrong." })`Uses ${question as never}.`;
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.provide(
            Effect.flatMap(Engineer, Effect.succeed),
            Wrong.pipe(
              Layer.provide(Layer.mergeAll(harness.layer, AI.DefaultModel(Smart))),
              Layer.provide(ModelsLive),
            ),
          ),
        );
        expect(String(exit)).toContain("mentions inputs its tag does not list: question");
      });
    }),
  );
});
