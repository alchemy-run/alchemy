import * as AI from "@alchemy.run/ai";
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
