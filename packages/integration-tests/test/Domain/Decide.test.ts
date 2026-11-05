import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@alchemy.run/test";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";

// Who is editing: what a session middleware provides to every command below.
class Editor extends Domain.RequestContext<Editor>()("Test/DecideEditor", Schema.String) {}
class Unauthenticated extends Domain.Rejection("Unauthenticated") {}
class EditorSession extends RpcMiddleware.Service<EditorSession, { provides: Editor }>()(
  "Test/DecideEditorSession",
  { error: Unauthenticated },
) {}

class NotYours extends Domain.Rejection("NotYours") {}
class Empty extends Domain.Rejection("Empty") {}

class Written extends Domain.Event("Written", { text: Schema.String, by: Schema.String }) {}
class Cleared extends Domain.Event("Cleared") {}

class Write extends Domain.Command("Write", {
  target: Schema.String,
  middleware: [EditorSession],
  input: { text: Schema.String },
  events: [Written],
  rejects: [NotYours],
}) {}
class Clear extends Domain.Command("Clear", {
  target: Schema.String,
  middleware: [EditorSession],
  events: [Cleared],
  rejects: [NotYours, Empty],
}) {}

const DraftState = Schema.Struct({ text: Schema.String, by: Schema.NullOr(Schema.String) });

/** A draft its author owns: the ownership check runs once, before either command. */
class Draft extends Domain.Aggregate("Draft", {
  id: Schema.String,
  state: DraftState,
  initial: { text: "", by: null },
  commands: [Write, Clear],
  decide: Effect.fn(function* (draft) {
    // Every command's middleware provides Editor, and every command declares NotYours.
    const editor = yield* Editor;
    if (draft.by !== null && draft.by !== editor) return yield* new NotYours();
    return {
      Write: (cmd) => [new Written({ text: cmd.text, by: editor })],
      Clear: () => (draft.text === "" ? new Empty() : [new Cleared()]),
    };
  }),
  evolve: {
    Written: (_, e) => ({ text: e.text, by: e.by }),
    Cleared: (draft) => ({ ...draft, text: "" }),
  },
}) {}

class Drafts extends Domain.Model("Drafts", { aggregates: [Draft] }) {}
const story = Story.make(Drafts);
const d1 = Draft.ref("d-1");

describe("Domain Aggregate decide", { tags: ["unit", "local"] }, () => {
  it.effect("returns the handlers for the instance's state; each command runs its own", () =>
    story(
      Story.provide(Editor, "sam"),
      Story.when(d1, new Write({ text: "hi" })),
      Story.then(d1, new Written({ text: "hi", by: "sam" })),
      Story.when(d1, new Clear()),
      Story.then(d1, new Cleared()),
      Story.when(d1, new Clear()),
      Story.rejected(new Empty()),
    ),
  );

  it.effect("the shared part refuses for every command, before any handler runs", () =>
    story(
      Story.given(d1, new Written({ text: "hi", by: "sam" })),
      Story.provide(Editor, "kim"),
      Story.when(d1, new Write({ text: "mine now" })),
      Story.rejected(new NotYours()),
      Story.when(d1, new Clear()),
      Story.rejected(new NotYours()),
    ),
  );

  it.effect("predict runs the same decide, shared part included", () =>
    Effect.sync(() => {
      const now = DateTime.makeUnsafe(0);
      const mine = Draft.predict({ text: "hi", by: "sam" }, new Clear(), {
        id: "d-1",
        now,
        context: Context.make(Editor, "sam"),
      });
      expect(mine._tag).toBe("Accepted");
      const theirs = Draft.predict({ text: "hi", by: "sam" }, new Clear(), {
        id: "d-1",
        now,
        context: Context.make(Editor, "kim"),
      });
      expect(theirs).toMatchObject({ _tag: "Rejected", rejection: { _tag: "NotYours" } });
    }),
  );

  it("the shared part may only fail with what every command declares, and read what every command's middleware provides", () => {
    class Lonely extends Domain.Command("Lonely", { target: Schema.String, events: [Cleared] }) {}
    Domain.Aggregate("Picky", {
      id: Schema.String,
      state: DraftState,
      initial: { text: "", by: null },
      commands: [Write, Clear],
      // @ts-expect-error Empty is declared by Clear, not by Write
      decide: Effect.fn(function* (draft) {
        if (draft.text === "") return yield* new Empty();
        return { Write: () => [], Clear: () => [] };
      }),
      evolve: { Written: (draft) => draft, Cleared: (draft) => draft },
    });
    Domain.Aggregate("Unguarded", {
      id: Schema.String,
      state: DraftState,
      initial: { text: "", by: null },
      commands: [Write, Lonely],
      // @ts-expect-error Lonely has no middleware, so nothing provides Editor to every command
      decide: Effect.fn(function* () {
        yield* Editor;
        return { Write: () => [], Lonely: () => [] };
      }),
      evolve: { Written: (draft) => draft, Cleared: (draft) => draft },
    });
  });
});
