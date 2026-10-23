import { domainFile, kindOfPath } from "../file.ts";
import { resolveImport } from "../files.ts";
import { moduleIndex } from "../files.ts";
import type { Rule } from "../types.ts";

/**
 * SKILL.md: "A rule that spans aggregates never becomes a cross-aggregate
 * transaction." and layout.md: "never by importing each other's aggregates".
 *
 * A file that declares an aggregate does not import another aggregate (by
 * value). Connect aggregates with a policy or a saga, or give the invariant its
 * own aggregate. Type-only imports are allowed.
 */
export const noCrossAggregateImport: Rule = {
  meta: {
    type: "problem",
    docs: { description: "An aggregate does not import another aggregate." },
    messages: {
      cross:
        "Aggregate `{{aggregate}}` imports the aggregate `{{other}}`. One command changes one aggregate: connect them with a policy or a saga, or give the shared invariant its own aggregate.",
    },
  },
  create(context) {
    return {
      Program(program) {
        const file = domainFile(context, program);
        const aggregate = file.blocks.find((block) => block.kind === "Aggregate");
        if (aggregate === undefined) return;
        for (const statement of program.body) {
          if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
          const source: string = statement.source.value;
          const target = resolveImport(context.filename, source);
          const index = target === undefined ? undefined : moduleIndex(target);
          for (const specifier of statement.specifiers) {
            if (specifier.importKind === "type") continue;
            const imported =
              specifier.type === "ImportSpecifier"
                ? (specifier.imported.name ?? specifier.imported.value)
                : undefined;
            const isAggregate =
              (imported !== undefined && index?.kinds.get(imported) === "Aggregate") ||
              (index === undefined && kindOfPath(source) === "Aggregate");
            if (isAggregate) {
              context.report({
                node: specifier,
                messageId: "cross",
                data: { aggregate: aggregate.name, other: specifier.local.name },
              });
            }
          }
        }
      },
    };
  },
};
