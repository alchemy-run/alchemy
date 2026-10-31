import { getProperty, io, nondeterminism, walkWithHelpers } from "../ast.ts";
import { domainFile } from "../file.ts";
import type { Node, Rule } from "../types.ts";

/** The pure parts of each block: they fold or decide from their arguments only. */
const PURE: Readonly<Record<string, ReadonlyArray<string>>> = {
  Aggregate: ["decide", "evolve", "reply"],
  View: ["evolve", "emit", "computed", "keyOf"],
};

/**
 * SKILL.md: "`decide` is pure, or an `Effect.fn` that reads only what its
 * command's middleware provides. It returns events or a rejection; it never
 * performs I/O." and "`evolve` only applies an event to state."
 *
 * Reports the clock, randomness, `process`, `fetch`, timers, `console` and
 * `Effect.promise` in an aggregate's `decide` / `evolve` / `reply` and a view's
 * `evolve` / `emit` / `computed` / `keyOf`, including inside local helpers they
 * call. `decide` gets the time as `{ now }` and `evolve` as `{ at }`.
 */
export const pureDecideEvolve: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "`decide`, `evolve` and the other folds read no clock, randomness, process or network.",
    },
    messages: {
      impure:
        "`{{part}}` must be pure, but {{via}}reads `{{what}}`. Use the `{ now }` (decide) or `{ at }` (evolve) argument for time, and derive ids from the command or the event.",
      io: "`{{part}}` must not perform I/O, but {{via}}uses `{{what}}`. Do I/O in a policy, saga or projection, through an external system or a port.",
    },
  },
  create(context) {
    return {
      Program(program) {
        const file = domainFile(context, program);
        const reported = new Set<Node>();
        for (const block of file.blocks) {
          const parts = PURE[block.kind];
          if (parts === undefined || block.definition === undefined) continue;
          for (const part of parts) {
            const property = getProperty(block.definition, part);
            if (property === undefined) continue;
            walkWithHelpers(property.value, file.helpers, (node, via) => {
              if (reported.has(node)) return;
              const clock = nondeterminism(node);
              const effect = clock === undefined ? io(node) : undefined;
              if (clock === undefined && effect === undefined) return;
              reported.add(node);
              context.report({
                node,
                messageId: clock === undefined ? "io" : "impure",
                data: {
                  part: `${block.name}.${part}`,
                  what: (clock ?? effect)!,
                  via: via === undefined ? "" : `through \`${via}\`, `,
                },
              });
            });
          }
        }
      },
    };
  },
};
