import { Match as M, Schema as S } from "effect";
import { Command, Runtime } from "foldkit";
import { html, type Document } from "foldkit/html";
import { m } from "foldkit/message";

// MODEL

export const Model = S.Struct({ count: S.Number });
export type Model = typeof Model.Type;

// MESSAGE

export const ClickedDecrement = m("ClickedDecrement");
export const ClickedIncrement = m("ClickedIncrement");
export const ClickedReset = m("ClickedReset");

export const Message = S.Union([
  ClickedDecrement,
  ClickedIncrement,
  ClickedReset,
]);
export type Message = typeof Message.Type;

const h = html<Message>();

// UPDATE

export const update = (
  model: Model,
  message: Message,
): readonly [Model, ReadonlyArray<Command.Command<Message>>] =>
  M.value(message).pipe(
    M.withReturnType<
      readonly [Model, ReadonlyArray<Command.Command<Message>>]
    >(),
    M.tagsExhaustive({
      ClickedDecrement: () => [{ count: model.count - 1 }, []],
      ClickedIncrement: () => [{ count: model.count + 1 }, []],
      ClickedReset: () => [{ count: 0 }, []],
    }),
  );

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => [
  { count: 0 },
  [],
];

// VIEW

export const view = (model: Model): Document => ({
  title: `Counter: ${model.count}`,
  body: h.div(
    [h.Id("app")],
    [
      h.p([h.Id("count")], [model.count.toString()]),
      h.div(
        [],
        [
          h.button([h.OnClick(ClickedDecrement())], ["-"]),
          h.button([h.OnClick(ClickedReset())], ["Reset"]),
          h.button([h.OnClick(ClickedIncrement())], ["+"]),
        ],
      ),
    ],
  ),
});
