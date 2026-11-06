import { isMember, unwrap } from "../ast.ts";
import type { Node, Rule } from "../types.ts";

const isProvide = (node: Node | undefined): boolean => {
  const target = unwrap(node);
  return target?.type === "CallExpression" && isMember(target.callee, "Effect", "provide");
};

const isPipeMember = (node: Node | undefined): boolean =>
  node?.type === "MemberExpression" &&
  !node.computed &&
  node.property.type === "Identifier" &&
  node.property.name === "pipe";

/** `Effect.provide(...)` calls in one `.pipe(...)` chain: `x.pipe(a, b).pipe(c)` → a, b, c. */
const pipeChain = (call: Node): Array<Node> => {
  const steps: Array<Node> = [];
  let current: Node | undefined = call;
  while (current?.type === "CallExpression") {
    const isPipe =
      (current.callee.type === "Identifier" && current.callee.name === "pipe") ||
      isPipeMember(current.callee);
    if (!isPipe) break;
    steps.unshift(...current.arguments);
    current =
      current.callee.type === "MemberExpression" ? unwrap(current.callee.object) : undefined;
  }
  return steps;
};

/**
 * SKILL.md: "Build one Layer and provide it once (`Layer.mergeAll`,
 * `Layer.provide`). Never chain `Effect.provide`."
 *
 * Reports a second `Effect.provide` in one pipe chain
 * (`x.pipe(Effect.provide(A), Effect.provide(B))`, `x.pipe(Effect.provide(A)).pipe(Effect.provide(B))`)
 * and a nested one (`Effect.provide(Effect.provide(x, A), B)`).
 * `Effect.provideService` is not counted: a policy uses it to stand in for middleware.
 */
export const noChainedProvide: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Provide one Layer once: never chain `Effect.provide`." },
    messages: {
      chained:
        "`Effect.provide` is already applied to this effect. Merge the layers (`Layer.mergeAll`, `Layer.provide`, `Layer.provideMerge`) and provide them once.",
    },
  },
  create(context) {
    const reported = new Set<Node>();
    return {
      CallExpression(node) {
        // Only the outermost call of a chain.
        const parent = node.parent;
        if (
          isPipeMember(parent) &&
          parent!.object === node &&
          parent!.parent?.type === "CallExpression" &&
          parent!.parent.callee === parent
        ) {
          return;
        }
        const provides = pipeChain(node).filter(isProvide);
        for (const extra of provides.slice(1)) {
          if (reported.has(extra)) continue;
          reported.add(extra);
          context.report({ node: extra, messageId: "chained" });
        }
        if (isMember(node.callee, "Effect", "provide") && node.arguments.length >= 2) {
          const inner = unwrap(node.arguments[0]);
          if (isProvide(inner) && unwrap(inner)!.arguments.length >= 2 && !reported.has(node)) {
            reported.add(node);
            context.report({ node, messageId: "chained" });
          }
          const innerSteps =
            inner?.type === "CallExpression" ? pipeChain(inner).filter(isProvide) : [];
          if (innerSteps.length > 0 && !reported.has(node)) {
            reported.add(node);
            context.report({ node, messageId: "chained" });
          }
        }
      },
    };
  },
};
