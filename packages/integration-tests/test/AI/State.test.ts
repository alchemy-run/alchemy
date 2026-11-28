import * as AI from "@alchemy.run/ai";
import { describe, expect, it } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { LanguageModel } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { recording } from "./fixtures/recording.ts";

/** The phase a session is in, and how often it moved on. */
class Phase extends AI.State("phase", {
  schema: Schema.Struct({
    phase: Schema.Literals(["research", "draft", "publish"]),
    moves: Schema.Number,
  }),
  initial: { phase: "research", moves: 0 },
}) {}

/** A value whose stored form differs from the one code holds. */
class Deadline extends AI.State("deadline", {
  schema: Schema.Struct({ at: Schema.DateTimeUtcFromString }),
  initial: { at: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)("2026-01-01T00:00:00Z") },
}) {}

class Smart extends AI.Model<Smart>()("smart") {}
/** No test here reaches a model. */
const ModelsLive = Smart.layer(Layer.succeed(LanguageModel.LanguageModel, undefined as never));

// Tools that use nothing but the session's state, as values: the recording
// harness calls a tool's handler as it is listed.
const Advance = AI.Tool(
  "advance",
  {
    description: "Move the session to its next phase.",
    parameters: Schema.Struct({}),
    success: Schema.Struct({ phase: Schema.String }),
  },
  Effect.fn(function* () {
    const next = yield* Phase.update((state) => ({
      phase: state.phase === "research" ? ("draft" as const) : ("publish" as const),
      moves: state.moves + 1,
    }));
    return { phase: next.phase };
  }),
);

const Publish = AI.Tool(
  "publish",
  {
    description: "Publish what was drafted.",
    parameters: Schema.Struct({}),
    success: Schema.Struct({ published: Schema.Boolean }),
  },
  Effect.fn(function* () {
    return { published: (yield* Phase.get).phase === "publish" };
  }),
);

class Writer extends AI.Process<Writer>()("Writer", {}) {}
const WriterLive = Writer.toLayer({ description: "Write one piece." })`
  Research, then say so with ${Advance}. Draft, ${Advance} again, then ${Publish}.
`;

/** A Writer played by code: `answer` stands in for the session's tools, so it has the session's state. */
const WriterPlayed = AI.scripted(
  Writer,
  Effect.succeed(
    Effect.fn(function* ({ text }: AI.Turn) {
      const next = yield* Phase.update((state) => ({ ...state, moves: state.moves + 1 }));
      return `${text}: ${next.moves}`;
    }),
  ),
);

/** A Writer on a harness that runs nothing: its tools are called by the test. */
const run = <A, E>(
  effect: (harness: ReturnType<typeof recording>) => Effect.Effect<A, E, Writer | RuntimeContext>,
) =>
  Effect.suspend(() => {
    const harness = recording();
    return effect(harness).pipe(
      Effect.provide(
        WriterLive.pipe(
          Layer.provideMerge(
            Layer.mergeAll(harness.layer, AI.DefaultModel(Smart), RuntimeContext.phantom),
          ),
          Layer.provide(ModelsLive),
        ),
      ),
    );
  });

describe("a session's state", { tags: ["unit"] }, () => {
  it.effect("a tool reads and writes the state of the session whose model called it", () =>
    run((harness) =>
      Effect.gen(function* () {
        const writer = yield* Writer;
        yield* writer.get("a").send("Write about owls.");
        yield* writer.get("b").send("Write about bats.");

        // A session that never wrote the state has what the declaration starts it with.
        expect(yield* harness.call("publish", {}, "call-1", "Writer/a")).toMatchObject({
          structured: { published: false },
        });

        yield* harness.call("advance", {}, "call-2", "Writer/a");
        yield* harness.call("advance", {}, "call-3", "Writer/a");
        expect(yield* harness.call("publish", {}, "call-4", "Writer/a")).toMatchObject({
          structured: { published: true },
        });

        // Another session of the same process has a value of its own.
        expect(yield* harness.call("publish", {}, "call-5", "Writer/b")).toMatchObject({
          structured: { published: false },
        });
      }),
    ),
  );

  it.effect("the code that holds a session reads and writes the same value from outside", () =>
    run((harness) =>
      Effect.gen(function* () {
        const writer = yield* Writer;
        yield* writer.get("a").send("Write about owls.");
        const phase = writer.get("a").state(Phase);

        expect(yield* phase.get).toEqual({ phase: "research", moves: 0 });
        yield* harness.call("advance", {}, "call-1", "Writer/a");
        expect(yield* phase.get).toEqual({ phase: "draft", moves: 1 });

        // What is written from outside is what the session's next tool call reads.
        yield* phase.set({ phase: "publish", moves: 7 });
        expect(yield* harness.call("publish", {}, "call-2", "Writer/a")).toMatchObject({
          structured: { published: true },
        });
        expect(yield* phase.update((state) => ({ ...state, moves: state.moves + 1 }))).toEqual({
          phase: "publish",
          moves: 8,
        });
      }),
    ),
  );

  it.effect("changes made at once are each made from the value before them", () =>
    run(() =>
      Effect.gen(function* () {
        const writer = yield* Writer;
        yield* writer.get("a").send("Write about owls.");
        const phase = writer.get("a").state(Phase);

        yield* Effect.forEach(
          Array.from({ length: 25 }),
          () => phase.update((state) => ({ ...state, moves: state.moves + 1 })),
          { concurrency: "unbounded" },
        );
        expect((yield* phase.get).moves).toBe(25);
      }),
    ),
  );

  it.effect("a value is stored as its schema encodes it", () =>
    run((harness) =>
      Effect.gen(function* () {
        const writer = yield* Writer;
        yield* writer.get("a").send("Write about owls.");
        const deadline = writer.get("a").state(Deadline);
        const at = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)("2027-03-04T05:06:07Z");

        yield* deadline.set({ at });
        expect(yield* deadline.get).toEqual({ at });
        expect(harness.values.get("state:Writer/a:deadline")).toBe(
          JSON.stringify({ at: "2027-03-04T05:06:07.000Z" }),
        );
      }),
    ),
  );

  it.effect("a hosted session's state is read and written in its own instance", () =>
    Effect.gen(function* () {
      const writer = yield* Writer;
      const phase = writer.get("a").state(Phase);

      expect((yield* writer.get("a").prompt("one")).text).toBe("one: 1");
      expect(yield* phase.get).toEqual({ phase: "research", moves: 1 });

      yield* phase.set({ phase: "draft", moves: 10 });
      expect((yield* writer.get("a").prompt("two")).text).toBe("two: 11");
      yield* Effect.forEach(
        Array.from({ length: 10 }),
        () => phase.update((state) => ({ ...state, moves: state.moves + 1 })),
        { concurrency: "unbounded" },
      );
      expect(yield* phase.get).toEqual({ phase: "draft", moves: 21 });
      // Another session's is its own.
      expect(yield* writer.get("b").state(Phase).get).toEqual({ phase: "research", moves: 0 });
    }).pipe(
      // Each session in an instance of its own: every call crosses to it.
      Effect.provide(AI.layerInMemory(WriterPlayed)),
      Effect.provide(RuntimeContext.phantom),
    ),
  );
});
