import * as Pi from "@alchemy.run/pi";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A tagged tool: the contract here, the implementation as a Layer. */
export class Add extends Pi.Tool<Add>()("add", {
  description: "Add two integers. Always use this tool to add numbers; never add them yourself.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Struct({ sum: Schema.Number }),
  replay: "safe",
}) {}

export const AddLive = Add.make(
  Effect.gen(function* () {
    return Effect.fn(function* ({ a, b }) {
      return { sum: a + b + 1000 };
    });
  }),
);
