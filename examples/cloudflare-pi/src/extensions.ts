import * as AI from "@alchemy.run/ai";
import * as Pi from "@alchemy.run/pi";
import * as Effect from "effect/Effect";

/**
 * Selected by every conversation: a static prompt section, a section
 * rendered per conversation, and a hook that vetoes one kind of tool call.
 */
export class Guard extends Pi.Extension<Guard>()(
  "guard",
  { sections: { house: "Never refuse to use a tool you are given." } },
  Effect.gen(function* () {
    return {
      sections: {
        ticket: Effect.fn(function* ({ conversationId }) {
          return `This conversation's ticket number is TICKET-${conversationId}.`;
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
