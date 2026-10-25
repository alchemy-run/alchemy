import { getProperty } from "../ast.ts";
import { domainFile } from "../file.ts";
import type { Rule } from "../types.ts";

type Range = readonly [number, number];

/**
 * SKILL.md: "Never `throw` for an outcome a caller handles. Fail with tagged
 * errors (`Domain.Rejection`, `Schema.TaggedError`). The one exception is an
 * `evolve` guard: an event that cannot apply to the current state is a bug in
 * `decide`, so `evolve` throws, the command dies, and nothing commits."
 *
 * The exception is lexical, so a reader checks it by looking at one function:
 * a `throw` written inside an aggregate's `evolve` is allowed. Every other
 * `throw` is reported, also in a helper that `evolve` calls, and in `reply`.
 * Share the condition as a pure predicate instead (`isOpen(s)`): `decide`
 * returns a rejection when it fails, `evolve` throws, `reply` only reads state.
 */
export const noThrow: Rule = {
  meta: {
    type: "problem",
    docs: {
      description: "No `throw` in the domain, except a guard written in an aggregate's `evolve`.",
    },
    messages: {
      throw:
        "Don't `throw` in the domain. Return or `yield*` a `Domain.Rejection` or a `Schema.TaggedError`, so the failure is typed. Only an aggregate's `evolve` may throw, written in `evolve` itself, to guard against an event that cannot apply: share the check as a pure predicate (`if (!isOpen(s)) throw ...`), not as a throwing helper.",
    },
  },
  create(context) {
    let evolve: Array<Range> = [];
    return {
      Program(program) {
        evolve = [];
        if (!context.sourceCode.text.includes("throw")) return;
        for (const block of domainFile(context, program).blocks) {
          if (block.kind !== "Aggregate") continue;
          const value = getProperty(block.definition, "evolve")?.value;
          if (value) evolve.push([value.start, value.end]);
        }
      },
      ThrowStatement(node) {
        if (evolve.some(([start, end]) => node.start >= start && node.end <= end)) return;
        context.report({ node, messageId: "throw" });
      },
    };
  },
};
