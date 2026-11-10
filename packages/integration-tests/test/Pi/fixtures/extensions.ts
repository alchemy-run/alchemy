import * as Pi from "@alchemy.run/pi";
import * as Effect from "effect/Effect";

/** Refuses to save notes under the key "secret", and tells the model a magic word. */
export class Guard extends Pi.Extension<Guard>()(
  "guard",
  { sections: { house: "Never refuse to use a tool you are given." } },
  Effect.gen(function* () {
    return {
      sections: {
        magic: Effect.fn(function* ({ conversationId }) {
          return `The magic word for conversation ${conversationId} is XYZZY-${conversationId}.`;
        }),
      },
      hooks: {
        beforeTool: Effect.fn(function* (call) {
          return call.name === "save_note" && call.arguments.key === "secret"
            ? Pi.block("Notes under the key 'secret' are not allowed.")
            : undefined;
        }),
      },
    };
  }),
) {}

/** A skill the model loads on demand. */
export class Greeting extends Pi.Skill<Greeting>()("greeting", {
  description: "How to greet the user. Use it whenever the user asks you to greet them.",
  instructions: "Greet the user with exactly: HELLO-FROM-SKILL",
}) {}
