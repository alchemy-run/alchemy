import { getProperty, handlerFunction, memberPath, unwrap, walk } from "../ast.ts";
import { domainFile } from "../file.ts";
import type { Node, Rule } from "../types.ts";

/**
 * SKILL.md: "`evolve` only applies an event to state. It never decides anything."
 *
 * In an aggregate's or a view's `evolve`, each handler returns the next state:
 * no `Effect`, no generator or `async`, no rejection, no new event.
 */
export const evolveOnlyApplies: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "`evolve` only applies an event: it returns state, never an Effect, a rejection or an event.",
    },
    messages: {
      effect:
        "`{{handler}}` in `evolve` returns an Effect. `evolve` returns the next state, synchronously; decide in `decide`.",
      rejects:
        "`{{handler}}` in `evolve` builds the rejection `{{name}}`. An event already happened: `evolve` applies it, and only `decide` may refuse.",
      records:
        "`{{handler}}` in `evolve` builds the event `{{name}}`. Only `decide` records events (a view emits them with `emit`).",
    },
  },
  create(context) {
    return {
      Program(program) {
        const file = domainFile(context, program);
        for (const block of file.blocks) {
          if (block.kind !== "Aggregate" && block.kind !== "View") continue;
          const evolve = unwrap(getProperty(block.definition, "evolve")?.value);
          if (evolve?.type !== "ObjectExpression") continue;
          for (const property of evolve.properties) {
            if (property.type !== "Property") continue;
            const handler =
              property.key.type === "Identifier"
                ? property.key.name
                : context.sourceCode.text.slice(property.key.start, property.key.end);
            const value = unwrap(property.value);
            const fn = handlerFunction(value);
            const wrapped =
              value?.type === "CallExpression" && memberPath(value.callee)?.[0] === "Effect";
            if (wrapped || fn?.generator || fn?.async) {
              context.report({ node: property.value, messageId: "effect", data: { handler } });
              continue;
            }
            walk(property.value, (node: Node) => {
              if (node.type === "CallExpression" && memberPath(node.callee)?.[0] === "Effect") {
                context.report({ node, messageId: "effect", data: { handler } });
                return false;
              }
              if (node.type === "NewExpression" && node.callee.type === "Identifier") {
                const kind = file.kindOf(node.callee.name);
                if (kind === "Rejection") {
                  context.report({
                    node,
                    messageId: "rejects",
                    data: { handler, name: node.callee.name },
                  });
                } else if (kind === "Event") {
                  context.report({
                    node,
                    messageId: "records",
                    data: { handler, name: node.callee.name },
                  });
                }
              }
              return undefined;
            });
          }
        }
      },
    };
  },
};
