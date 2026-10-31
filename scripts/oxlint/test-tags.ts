/**
 * Oxlint JS plugin: every alchemy-test test must carry one of the kind tags
 * `unit`, `local` or `live`, on the test itself or an enclosing `describe`.
 *
 * Tags written as literals, arrays, spreads, conditionals and in-file
 * `const`s are checked. Anything the rule can't see through (a function
 * parameter, a call) is trusted, so a shared helper that forwards tags
 * never needs a disable comment.
 */

const KINDS = new Set(["unit", "local", "live"]);
const TEST_RUNNER = "@alchemy.run/test";
// Members that build a registration function instead of registering a test.
const FACTORIES = new Set(["skipIf", "runIf", "each", "for"]);
// Members a registration chain may use, e.g. `test.provider.skipIf(x)(...)`.
const MEMBERS = new Set([
  ...FACTORIES,
  "concurrent",
  "effect",
  "fails",
  "live",
  "only",
  "provider",
  "scoped",
  "sequential",
  "skip",
  "todo",
]);

type Node = { type: string; parent?: Node; [key: string]: any };
type Verdict = "yes" | "no" | "unknown";

interface Context {
  report(descriptor: { node: Node; message: string }): void;
}

/**
 * `test.provider.skipIf(x)` → `test`, `handle.test.skip` → `test` (a
 * `Test.make` handle), `test.pipe` → undefined.
 */
const rootName = (callee: Node): string | undefined => {
  let node: Node | undefined = callee;
  while (node) {
    if (node.type === "Identifier") return node.name;
    if (node.type === "MemberExpression") {
      if (node.property.type !== "Identifier") return undefined;
      if (node.property.name === "test" || node.property.name === "it") return node.property.name;
      if (!MEMBERS.has(node.property.name)) return undefined;
      node = node.object;
    } else if (node.type === "CallExpression") node = node.callee;
    else return undefined;
  }
  return undefined;
};

const propertyName = (callee: Node): string | undefined =>
  callee.type === "MemberExpression" && callee.property.type === "Identifier"
    ? callee.property.name
    : undefined;

const isRegistration = (node: Node, roots: Set<string>) => {
  if (node.type !== "CallExpression" || node.arguments.length < 2) return false;
  const root = rootName(node.callee);
  const member = propertyName(node.callee);
  return root !== undefined && roots.has(root) && !FACTORIES.has(member ?? "");
};

const all = (verdicts: Array<Verdict>): Verdict =>
  verdicts.every((v) => v === "yes") ? "yes" : verdicts.includes("unknown") ? "unknown" : "no";

const any = (verdicts: Array<Verdict>): Verdict =>
  verdicts.includes("yes") ? "yes" : verdicts.includes("unknown") ? "unknown" : "no";

const create = (context: Context) => {
  const consts = new Map<string, Node>();
  const resolve = (name: string, seen: Set<string>): Node | undefined => {
    if (seen.has(name)) return undefined;
    seen.add(name);
    return consts.get(name);
  };

  /** Whether a tags expression includes a kind tag. */
  const hasKind = (node: Node | undefined, seen = new Set<string>()): Verdict => {
    if (!node) return "no";
    switch (node.type) {
      case "Literal":
        return typeof node.value === "string" && KINDS.has(node.value) ? "yes" : "no";
      case "TemplateLiteral":
        return node.expressions.length === 0 && KINDS.has(node.quasis[0].value.cooked)
          ? "yes"
          : node.expressions.length === 0
            ? "no"
            : "unknown";
      case "ArrayExpression":
        return any(
          node.elements.map((element: Node | null) => hasKind(element ?? undefined, seen)),
        );
      case "SpreadElement":
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "ParenthesizedExpression":
        return hasKind(node.argument ?? node.expression, seen);
      case "ConditionalExpression":
        return all([hasKind(node.consequent, seen), hasKind(node.alternate, seen)]);
      case "Identifier": {
        const init = resolve(node.name, seen);
        return init ? hasKind(init, seen) : "unknown";
      }
      default:
        return "unknown";
    }
  };

  /** Whether an options argument tags its test or suite with a kind. */
  const optionsHaveKind = (options: Node | undefined): Verdict => {
    if (options?.type === "Identifier") {
      const init = resolve(options.name, new Set());
      return init ? optionsHaveKind(init) : "unknown";
    }
    if (!options) return "no";
    // A helper building the options, e.g. `liveOptions(900_000)`.
    if (options.type !== "ObjectExpression") return "unknown";
    const verdicts: Array<Verdict> = [];
    for (const property of options.properties as Array<Node>) {
      if (property.type === "SpreadElement") verdicts.push("unknown");
      else if (
        !property.computed &&
        ((property.key.type === "Identifier" && property.key.name === "tags") ||
          (property.key.type === "Literal" && property.key.value === "tags"))
      )
        verdicts.push(hasKind(property.value));
    }
    return any(verdicts);
  };

  // `test(name, body, options)` and `describe(name, options, body)`.
  const testOptions = (call: Node) => call.arguments[2];
  const suiteOptions = (call: Node) => (call.arguments.length >= 3 ? call.arguments[1] : undefined);

  const tests = new Set(["test", "it"]);
  const suites = new Set(["describe"]);

  return {
    // `import { describe as suite } from "@alchemy.run/test"`.
    ImportSpecifier(node: Node) {
      if (node.parent?.source?.value !== TEST_RUNNER) return;
      const imported = node.imported.name ?? node.imported.value;
      if (imported === "describe") suites.add(node.local.name);
      if (imported === "test" || imported === "it") tests.add(node.local.name);
    },
    VariableDeclarator(node: Node) {
      if (node.id.type === "Identifier" && node.init && node.parent?.kind === "const")
        consts.set(node.id.name, node.init);
    },
    "Program:exit"(program: Node) {
      const visit = (node: Node) => {
        if (isRegistration(node, tests) && propertyName(node.callee) !== "todo") check(node);
        for (const key of Object.keys(node)) {
          if (key === "parent") continue;
          const child = node[key];
          if (Array.isArray(child)) {
            for (const c of child) if (c && typeof c.type === "string") visit(c);
          } else if (child && typeof child.type === "string") visit(child);
        }
      };
      const check = (call: Node) => {
        if (optionsHaveKind(testOptions(call)) !== "no") return;
        for (let node = call.parent; node; node = node.parent) {
          if (isRegistration(node, suites) && optionsHaveKind(suiteOptions(node)) !== "no") return;
        }
        context.report({
          node: call,
          message:
            'Tag this test with its kind: add "unit", "local" or "live" to its `tags` or an enclosing describe\'s.',
        });
      };
      visit(program);
    },
  };
};

export default {
  meta: { name: "alchemy-test" },
  rules: {
    "require-kind-tag": {
      meta: {
        type: "problem",
        docs: { description: 'Require a "unit", "local" or "live" tag on every test.' },
      },
      create,
    },
  },
};
