import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";

// A saga step and a policy write one Registry concurrently (#3097): the saga
// settles a Subject, whose Settled event triggers a policy that writes the
// Registry, while the saga's next step admits on the same Registry.

const RegistryId = Schema.String.pipe(Schema.brand("RegistryId"));
const SubjectId = Schema.String.pipe(Schema.brand("SubjectId"));

class Recorded extends Domain.Event("Recorded") {}
class Admitted extends Domain.Event("Admitted", { payloadHash: Schema.String }) {}
/** How many events the Registry had when it was counted: depends on what committed first. */
class Counted extends Domain.Event("Counted", { seen: Schema.Int }) {}
class Record extends Domain.Command("Record", { target: RegistryId, events: [Recorded] }) {}
class Admit extends Domain.Command("Admit", {
  target: RegistryId,
  input: { payloadHash: Schema.String },
  events: [Admitted],
}) {}
class Count extends Domain.Command("Count", { target: RegistryId, events: [Counted] }) {}
/** Commits Recorded, Admitted("b"), Recorded in one decision. */
class Batch extends Domain.Command("Batch", { target: RegistryId, events: [Recorded, Admitted] }) {}

class Registry extends Domain.Aggregate("Registry", {
  id: RegistryId,
  state: Schema.Array(Schema.String),
  initial: [],
  commands: [Record, Admit, Count, Batch],
  decide: {
    Record: () => [new Recorded()],
    Admit: (_, c) => [new Admitted({ payloadHash: c.payloadHash })],
    Count: (s) => [new Counted({ seen: s.length })],
    Batch: () => [new Recorded(), new Admitted({ payloadHash: "b" }), new Recorded()],
  },
  evolve: {
    Recorded: (s) => [...s, "Recorded"],
    Admitted: (s) => [...s, "Admitted"],
    Counted: (s) => [...s, "Counted"],
  },
}) {}

class Requested extends Domain.Event("Requested") {}
class Settled extends Domain.Event("Settled") {}
class Request extends Domain.Command("Request", { target: SubjectId, events: [Requested] }) {}
class Settle extends Domain.Command("Settle", { target: SubjectId, events: [Settled] }) {}

class Subject extends Domain.Aggregate("Subject", {
  id: SubjectId,
  state: Schema.Int,
  initial: 0,
  commands: [Request, Settle],
  decide: { Request: () => [new Requested()], Settle: () => [new Settled()] },
  evolve: { Requested: (s) => s, Settled: (s) => s + 1 },
}) {}

class Process extends Domain.Saga("Process", { key: SubjectId }) {}
class Start extends Domain.Policy("Start", { from: Subject, on: [Requested] }) {}
class Settlement extends Domain.Policy("Settlement", { from: Subject, on: [Settled] }) {}

const registry = Registry.ref("shared");
const subject = Subject.ref("subject");

const encoded = '{"operation":"next","payload":{"value":1}}';
const payloadHash = "14f534f44bad9077709b47768e12caec5e8be78fa63301794b88fa39793624c2";

/** Hash with Web Crypto, as the reporter's model does: it resumes the saga from the thread pool. */
const digest = Effect.gen(function* () {
  const bytes = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded)),
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
});

const StartLive = Start.toLayer(
  Effect.gen(function* () {
    const runs = yield* Process;
    return Effect.fn(function* ({ source }) {
      yield* runs.start(source, {});
    });
  }),
);

/** The policy records on the Registry: either order gives the same events. */
const SettlementRecords = Settlement.toLayer(
  Effect.gen(function* () {
    const registries = yield* Registry;
    return Effect.fn(function* () {
      yield* registries.send(registry, new Record());
    });
  }),
);

/** The policy counts the Registry: what it sees depends on whether the saga admitted first. */
const SettlementCounts = Settlement.toLayer(
  Effect.gen(function* () {
    const registries = yield* Registry;
    return Effect.fn(function* () {
      yield* registries.send(registry, new Count());
    });
  }),
);

const ProcessLive = Process.toLayer(
  Effect.gen(function* () {
    const subjects = yield* Subject;
    const registries = yield* Registry;
    return Effect.fn(function* ({ key }) {
      yield* Activity.make({
        name: "settle",
        execute: subjects.send(key, new Settle()).pipe(Effect.asVoid),
      });
      yield* Activity.make({
        name: "admit-next",
        execute: Effect.gen(function* () {
          yield* registries.send(registry, new Admit({ payloadHash: yield* digest }));
        }),
      });
    });
  }),
);

class Model extends Domain.Model("Model", {
  aggregates: [Registry, Subject],
  policies: [Start, Settlement],
  sagas: [Process],
}) {}

const story = Story.make(Model, {
  layer: Layer.mergeAll(StartLive, SettlementRecords, ProcessLive),
});
const countingStory = Story.make(Model, {
  layer: Layer.mergeAll(StartLive, SettlementCounts, ProcessLive),
});

const settle = [
  Story.when(subject, new Request()),
  Story.saga(Process, subject, { _tag: "Completed", result: undefined }),
  Story.then(subject, new Requested(), new Settled()),
] as const;

const messageOf = (failure: unknown) => String((failure as { message?: unknown }).message);
const orderOf = (failure: unknown) => (failure as { order?: ReadonlyArray<string> }).order ?? [];

describe("Domain Story: event order", { tags: ["unit", "local"] }, () => {
  it.effect("a story runs each order of two writers to one stream", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      yield* story(
        ...settle,
        Story.state(registry, (state) => void seen.push(state.join(" → "))),
        Story.then(registry, Story.anyOrder(new Recorded(), new Admitted({ payloadHash }))),
      );
      expect(seen).toEqual(["Recorded → Admitted", "Admitted → Recorded"]);
    }),
  );

  it.effect("an ordered then fails, every time, in the order it does not hold", () =>
    Effect.forEach(
      Array.from({ length: 5 }),
      () =>
        story(...settle, Story.then(registry, new Recorded(), new Admitted({ payloadHash }))).pipe(
          Effect.flip,
          Effect.map((failure) => {
            const message = messageOf(failure);
            expect(message).toContain(
              'Then: on Registry/shared\n  expected [{"_tag":"Recorded"},{"_tag":"Admitted","payloadHash":"14f5',
            );
            expect(message).toContain(
              "The same events, in another order. 2 different commands wrote them in step 1; if the model does not order them, wrap them in Story.anyOrder(...)",
            );
            expect(message).toContain("in another order of concurrent work: saga ");
            expect(orderOf(failure)).toHaveLength(1);
          }),
        ),
      { discard: true },
    ),
  );

  it.effect("an outcome that depends on the order fails in the order that changes it", () =>
    countingStory(
      ...settle,
      Story.then(registry, Story.anyOrder(new Counted({ seen: 0 }), new Admitted({ payloadHash }))),
    ).pipe(
      Effect.flip,
      Effect.map((failure) => {
        expect(messageOf(failure)).toContain('{"_tag":"Counted","seen":1}');
        expect(orderOf(failure)).toHaveLength(1);
      }),
    ),
  );

  it.effect("anyOrder matches payloads, not just tags", () =>
    story(
      ...settle,
      Story.then(registry, Story.anyOrder(new Recorded(), new Admitted({ payloadHash: "other" }))),
    ).pipe(
      Effect.flip,
      Effect.map((failure) => {
        const message = messageOf(failure);
        expect(message).toContain(
          'expected [anyOrder({"_tag":"Recorded"},{"_tag":"Admitted","payloadHash":"other"})]',
        );
        expect(message).not.toContain("The same events, in another order");
        // It fails in the first order already.
        expect(orderOf(failure)).toEqual([]);
      }),
    ),
  );

  it.effect("inOrder inside anyOrder lets other events interleave", () =>
    story(
      Story.when(registry, new Batch()),
      Story.then(
        registry,
        Story.anyOrder(
          Story.inOrder(new Recorded(), new Recorded()),
          new Admitted({ payloadHash: "b" }),
        ),
      ),
    ),
  );

  it.effect("inOrder inside anyOrder still holds its own order", () =>
    story(
      Story.when(registry, new Batch()),
      Story.then(
        registry,
        Story.anyOrder(
          Story.inOrder(new Admitted({ payloadHash: "b" }), new Recorded(), new Recorded()),
        ),
      ),
    ).pipe(
      Effect.flip,
      Effect.map((failure) => {
        const message = messageOf(failure);
        expect(message).toContain("expected [anyOrder(inOrder(");
        // One command wrote all three, so its order is defined: no hint.
        expect(message).not.toContain("The same events, in another order");
      }),
    ),
  );

  it.effect("anyOrder counts each event once", () =>
    story(
      Story.when(registry, new Batch()),
      Story.then(registry, Story.anyOrder(new Recorded(), new Recorded(), new Recorded())),
    ).pipe(
      Effect.flip,
      Effect.map((failure) => expect(messageOf(failure)).toContain("Then: on Registry/shared")),
    ),
  );

  it.effect("a group consumes its events, and later steps assert the rest", () =>
    story(
      Story.when(registry, new Batch()),
      Story.then(registry, Story.anyOrder(new Admitted({ payloadHash: "b" }), new Recorded())),
      Story.then(registry, new Recorded()),
    ),
  );

  it.effect("events a group leaves unasserted fail the story at the end", () =>
    story(
      Story.when(registry, new Batch()),
      Story.then(registry, Story.anyOrder(new Admitted({ payloadHash: "b" }), new Recorded())),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(messageOf(failure)).toContain("committed events no step asserts"),
      ),
    ),
  );
});

// Fan-out: one event reaches several policies at once.

const Fans = [0, 1, 2, 3, 4, 5].map(
  (i) => class extends Domain.Policy(`Fan${i}`, { from: Subject, on: [Requested] }) {},
);

class FanModel extends Domain.Model("FanModel", {
  aggregates: [Registry, Subject],
  policies: Fans,
}) {}

/** Each fan policy either writes nothing, or records on the one shared Registry. */
const fanStory = (writes: boolean) =>
  Story.make(FanModel, {
    layer: Layer.mergeAll(
      Layer.empty,
      ...Fans.map((Fan) =>
        Fan.toLayer(
          Effect.gen(function* () {
            const registries = yield* Registry;
            return Effect.fn(function* () {
              if (writes) yield* registries.send(registry, new Record());
            });
          }),
        ),
      ),
    ),
  });

describe("Domain Story: orders of fan-out", { tags: ["unit", "local"] }, () => {
  it.effect("policies that commit to no common stream run in one order", () =>
    Effect.gen(function* () {
      let runs = 0;
      yield* fanStory(false)(
        Story.when(subject, new Request()),
        Story.state(subject, () => void runs++),
        Story.then(subject, new Requested()),
      );
      expect(runs).toBe(1);
    }),
  );

  it.effect("too many orders on one stream fail the story instead of checking some", () =>
    fanStory(true)(
      Story.when(subject, new Request()),
      Story.then(subject, new Requested()),
      Story.then(
        registry,
        new Recorded(),
        new Recorded(),
        new Recorded(),
        new Recorded(),
        new Recorded(),
        new Recorded(),
      ),
    ).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(messageOf(failure)).toContain(
          "the story has more than 256 orders of concurrent work that commit to the same streams; split it into smaller stories",
        ),
      ),
    ),
  );
});

// A group takes only the stream's events, at any depth.
// @ts-expect-error Requested is a Subject event, not a Registry one
export const foreign = Story.then(registry, Story.anyOrder(new Recorded(), new Requested()));
export const foreignNested = Story.then(
  registry,
  // @ts-expect-error Requested is a Subject event, not a Registry one
  Story.anyOrder(Story.inOrder(new Recorded(), new Requested())),
);
