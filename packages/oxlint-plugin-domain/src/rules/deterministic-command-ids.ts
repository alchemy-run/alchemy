import { memberPath, nondeterminism, propertyName, unwrap, walkWithHelpers } from "../ast.ts";
import { type DomainFile, domainFile } from "../file.ts";
import type { Rule } from "../types.ts";

const HANDLERS = new Set(["Policy", "Projection"]);

/**
 * SKILL.md: "Policies and projections run at least once. Make their effects
 * idempotent: commands sent from a handler get deterministic ids, and stores
 * key rows by `stream:seq`."
 *
 * Inside a policy's or projection's `toLayer(...)`, nothing may come from the
 * clock or randomness (a second run would send a different command or write a
 * different row), and an explicit `commandId` must depend on the input (a
 * constant id makes every event send the same command).
 */
export const deterministicCommandIds: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Policy and projection handlers derive ids from their input, never from the clock or randomness.",
    },
    messages: {
      random:
        "`{{handler}}` runs at least once, but reads `{{what}}`: a retry sends a different command or writes a different row. Derive ids from the event (`envelope.stream`, `envelope.seq`, the source id), or let the platform assign the `commandId`.",
      constant:
        "`commandId` in `{{handler}}` is a constant, so every event sends the same command and only the first one runs. Derive it from the event.",
    },
  },
  create(context) {
    let file: DomainFile | undefined;
    return {
      Program(program) {
        file = domainFile(context, program);
      },
      CallExpression(call) {
        const path = memberPath(call.callee);
        if (file === undefined || path?.length !== 2 || path[1] !== "toLayer") return;
        const handler = path[0]!;
        const kind = file.kindOf(handler);
        if (kind === undefined || !HANDLERS.has(kind)) return;
        for (const argument of call.arguments) {
          walkWithHelpers(argument, file.helpers, (node) => {
            const what = nondeterminism(node);
            if (what !== undefined) {
              context.report({ node, messageId: "random", data: { handler, what } });
              return;
            }
            if (node.type === "Property" && propertyName(node) === "commandId") {
              const value = unwrap(node.value);
              const constant =
                value?.type === "Literal" ||
                (value?.type === "TemplateLiteral" && value.expressions.length === 0);
              if (constant) {
                context.report({ node: node.value, messageId: "constant", data: { handler } });
              }
            }
          });
        }
      },
    };
  },
};
