import { isMember, memberPath, unwrap, walk } from "../ast.ts";
import { type DomainFile, domainFile, kindOfPath } from "../file.ts";
import type { Node, Rule } from "../types.ts";

/**
 * SKILL.md: "Don't wait for a saga in a policy. `start` it, keyed by the
 * aggregate it's about, and react to the events its steps record."
 *
 * In a policy's handler: reading a saga run's `result` (it waits for the run
 * to end) and `DurableDeferred.await` (only a saga may wait) are reported. A
 * saga client is a variable bound with `yield* SomeSaga`; a run is
 * `yield* client.start(...)` or `client.get(...)`. The handler is the whole of
 * a `.policy.ts` file, and elsewhere (a server file, or a test that declares a
 * model inline) the arguments of `<Policy>.toLayer(...)`, so a saga or a test
 * in the same file may wait.
 */
export const policyNoSagaWait: Rule = {
  meta: {
    type: "problem",
    docs: { description: "A policy starts or signals a saga; it never waits for one." },
    messages: {
      result:
        "This policy waits for the saga `{{saga}}` to finish (`.result`). A policy only `start`s or signals a saga: react to the events its steps record instead.",
      await:
        "A policy does not wait (`DurableDeferred.await`). Move the wait into a saga, and have the policy `start` or `signal` it.",
    },
  },
  create(context) {
    let file: DomainFile | undefined;
    let wholeFile = false;
    let handlers: Array<readonly [number, number]> = [];
    const inPolicy = (node: Node) =>
      wholeFile || handlers.some(([start, end]) => node.start >= start && node.end <= end);
    const clients = new Map<string, string>();
    const runs = new Map<string, string>();

    /** The saga name if `node` is `client.start(...)` / `yield* client.start(...)` / `client.get(...)`. */
    const runOf = (raw: Node | undefined): string | undefined => {
      let node = unwrap(raw);
      if (node?.type === "YieldExpression" && node.delegate) node = unwrap(node.argument);
      if (node?.type === "AwaitExpression") node = unwrap(node.argument);
      if (node?.type === "Identifier") return runs.get(node.name);
      if (node?.type !== "CallExpression") return undefined;
      const path = memberPath(node.callee);
      if (path?.length !== 2 || (path[1] !== "start" && path[1] !== "get")) return undefined;
      return clients.get(path[0]!);
    };

    return {
      Program(program) {
        const current = domainFile(context, program);
        file = current;
        wholeFile = kindOfPath(context.filename) === "Policy";
        handlers = [];
        if (wholeFile || !context.sourceCode.text.includes("toLayer")) return;
        walk(program, (node) => {
          if (node.type !== "CallExpression") return;
          const path = memberPath(node.callee);
          if (
            path?.length === 2 &&
            path[1] === "toLayer" &&
            current.kindOf(path[0]!) === "Policy"
          ) {
            handlers.push([node.start, node.end]);
          }
        });
      },
      VariableDeclarator(node) {
        if (file === undefined || node.id.type !== "Identifier" || !inPolicy(node)) return;
        const init = unwrap(node.init);
        if (init?.type === "YieldExpression" && init.delegate) {
          const target = unwrap(init.argument);
          if (target?.type === "Identifier" && file.kindOf(target.name) === "Saga") {
            clients.set(node.id.name, target.name);
            return;
          }
        }
        const saga = runOf(init);
        if (saga !== undefined) runs.set(node.id.name, saga);
      },
      MemberExpression(node) {
        if (!inPolicy(node)) return;
        if (isMember(node, "DurableDeferred", "await")) {
          context.report({ node, messageId: "await" });
          return;
        }
        if (node.computed || node.property.type !== "Identifier" || node.property.name !== "result")
          return;
        const saga = runOf(node.object);
        if (saga !== undefined) context.report({ node, messageId: "result", data: { saga } });
      },
    };
  },
};
