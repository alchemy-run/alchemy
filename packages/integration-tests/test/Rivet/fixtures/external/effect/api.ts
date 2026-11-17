/** RivetKit's Effect form (`@rivetkit/effect`): the Actor's contract. */
import { Action, Actor } from "@rivetkit/effect";
import * as Schema from "effect/Schema";

export const Add = Action.make("Add", {
  payload: { amount: Schema.Number },
  success: Schema.Number,
});

export const Read = Action.make("Read", {
  success: Schema.Number,
});

export const Counter = Actor.make("Counter", {
  actions: [Add, Read],
});
