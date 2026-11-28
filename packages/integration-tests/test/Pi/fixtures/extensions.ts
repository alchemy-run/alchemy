import * as AI from "@alchemy.run/ai";
import * as Pi from "@alchemy.run/pi";
import * as Effect from "effect/Effect";
import { Phase } from "./tools.ts";

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

/** Tells the model which phase its conversation is in, read from the conversation's state. */
export class Phases extends Pi.Extension<Phases>()(
  "phases",
  {},
  Effect.gen(function* () {
    return {
      sections: {
        phase: Effect.fn(function* () {
          return `This conversation is in the ${(yield* Phase.get).phase.toUpperCase()} phase.`;
        }),
      },
    };
  }),
) {}
