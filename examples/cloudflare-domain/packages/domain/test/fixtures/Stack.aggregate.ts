import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class Pushed extends Domain.Event("Pushed", { item: Schema.String }) {}

export class Push extends Domain.Command("Push", {
  target: Schema.String,
  input: { item: Schema.String },
  events: [Pushed],
}) {}

/** Its `evolve` pushes onto the list it was given, which changes the state it was handed. */
export class Stack extends Domain.Aggregate("Stack", {
  id: Schema.String,
  state: Schema.Struct({ items: Schema.Array(Schema.String) }),
  initial: { items: [] },
  invariants: { NeverTooTall: (stack) => stack.items.length < 100 },
  commands: [Push],
  decide: {
    Push: (_state, command) => [new Pushed({ item: command.item })],
  },
  evolve: {
    Pushed: (state, event) => {
      const items = state.items as Array<string>;
      items.push(event.item);
      return { items };
    },
  },
}) {}
