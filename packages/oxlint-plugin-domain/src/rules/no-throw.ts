import type { Rule } from "../types.ts";

/**
 * SKILL.md: "Never `throw`. Fail with tagged errors (`Domain.Rejection`, `Schema.TaggedError`)."
 */
export const noThrow: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Never `throw` in the domain: fail with a tagged error." },
    messages: {
      throw:
        "Don't `throw` in the domain. Return or `yield*` a `Domain.Rejection` or a `Schema.TaggedError`, so the failure is typed.",
    },
  },
  create(context) {
    return {
      ThrowStatement: (node) => context.report({ node, messageId: "throw" }),
    };
  },
};
