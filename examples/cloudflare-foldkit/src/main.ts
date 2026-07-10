import { Match, Schema } from "effect";
import { Command, Runtime } from "foldkit";
import type { Html } from "foldkit/html";
import { html } from "foldkit/html";
import { m } from "foldkit/message";

// Foldkit is an Elm-style framework on Effect: one immutable Model, a closed
// union of Messages, one `update` folding Messages into the next Model, and a
// pure `view`. This example is the canonical counter.

// MODEL

const Model = Schema.Struct({
  count: Schema.Number,
});
type Model = typeof Model.Type;

// MESSAGE

const Incremented = m("Incremented");
const Decremented = m("Decremented");
const Reset = m("Reset");

const Message = Schema.Union([Incremented, Decremented, Reset]);
type Message = typeof Message.Type;

// UPDATE

const init = (): readonly [Model, ReadonlyArray<Command.Command<Message>>] => [
  { count: 0 },
  [],
];

const update = (
  model: Model,
  message: Message,
): readonly [Model, ReadonlyArray<Command.Command<Message>>] =>
  Match.value(message).pipe(
    Match.withReturnType<
      readonly [Model, ReadonlyArray<Command.Command<Message>>]
    >(),
    Match.tagsExhaustive({
      Incremented: () => [{ count: model.count + 1 }, []],
      Decremented: () => [{ count: model.count - 1 }, []],
      Reset: () => [{ count: 0 }, []],
    }),
  );

// VIEW

const h = html<Message>();

const view = (model: Model): Html =>
  h.main(
    [h.Class("card")],
    [
      h.h1([], ["Foldkit on Cloudflare"]),
      h.p([h.Class("count")], [String(model.count)]),
      h.div(
        [h.Class("row")],
        [
          h.button([h.OnClick(Decremented())], ["−1"]),
          h.button([h.OnClick(Reset())], ["Reset"]),
          h.button([h.OnClick(Incremented())], ["+1"]),
        ],
      ),
      h.p(
        [h.Class("hint")],
        [
          "An Elm-style counter: messages in, a fold over the model, a pure view out.",
        ],
      ),
    ],
  );

// RUNTIME

Runtime.run(
  Runtime.makeElement({
    Model,
    init,
    update,
    view,
    container: document.getElementById("root"),
  }),
);
