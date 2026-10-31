import type { Rule } from "../types.ts";

/** `decide` rejects invalid commands; `evolve` and `reply` are total. */
export const noThrow: Rule = {
  meta: {
    type: "problem",
    docs: {
      description: "No `throw` in the domain, including `evolve` and `reply`.",
    },
    messages: {
      throw:
        "Don't `throw` in the domain. Reject invalid commands with a declared tagged error in `decide`. Keep `evolve` and `reply` total; an event that does not apply leaves the state unchanged.",
    },
  },
  create(context) {
    return {
      ThrowStatement(node) {
        context.report({ node, messageId: "throw" });
      },
    };
  },
};
