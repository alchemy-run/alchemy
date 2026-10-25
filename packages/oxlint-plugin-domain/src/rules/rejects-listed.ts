import { getProperty, propertyName, unwrap, walkWithHelpers } from "../ast.ts";
import { type DomainFile, domainFile, rejectsNames } from "../file.ts";
import type { Context, Node, Rule } from "../types.ts";

/**
 * SKILL.md: "Every rejection a command can return is listed in its `rejects`.
 * Callers handle each one with `Effect.catchTag`."
 *
 * For each `decide` handler of an aggregate, the rejections it builds (`new
 * NotOpen()`, also inside local helpers it calls) must be in the command's
 * `rejects`. The command may live in another file: its `rejects` list is read
 * from that file. Same check for a view's `validate` against its `rejects`,
 * and an aggregate's `read.validate` against `read.rejects`.
 */
export const rejectsListed: Rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Every rejection a command (or read) can return is listed in its `rejects`.",
    },
    messages: {
      unlisted:
        "`{{owner}}` can return `{{rejection}}`{{via}}, but `{{rejection}}` is not in its `rejects`. Add it, so callers see it in the type and handle it.",
    },
  },
  create(context) {
    return {
      Program(program) {
        const file = domainFile(context, program);
        for (const block of file.blocks) {
          if (block.definition === undefined) continue;
          if (block.kind === "Aggregate") {
            const decide = unwrap(getProperty(block.definition, "decide")?.value);
            if (decide?.type === "ObjectExpression") {
              for (const property of decide.properties) {
                const command = propertyName(property);
                if (command === undefined) continue;
                const listed = file.rejectsOf(command);
                if (listed === undefined) continue;
                check(context, file, property.value, command, listed);
              }
            }
            const read = getProperty(block.definition, "read")?.value;
            const validate = getProperty(read, "validate");
            const listed = rejectsNames(getProperty(read, "rejects"));
            if (validate && listed) {
              check(
                context,
                file,
                validate.value,
                `${block.name}.read`,
                listed.map((name) => file.originalName(name)),
              );
            }
          } else if (block.kind === "View" || block.kind === "Stream") {
            const validate = getProperty(block.definition, "validate");
            const listed = file.rejectsOf(block.name);
            if (validate && listed) check(context, file, validate.value, block.name, listed);
          }
        }
      },
    };
  },
};

const check = (
  context: Context,
  file: DomainFile,
  handler: Node,
  owner: string,
  listed: ReadonlyArray<string>,
) => {
  const allowed = new Set(listed);
  walkWithHelpers(handler, file.helpers, (node, via) => {
    if (node.type !== "NewExpression" || node.callee.type !== "Identifier") return;
    const name = node.callee.name;
    if (file.kindOf(name) !== "Rejection") return;
    const original = file.originalName(name);
    if (allowed.has(original) || allowed.has(name)) return;
    context.report({
      node,
      messageId: "unlisted",
      data: { owner, rejection: name, via: via === undefined ? "" : ` (through \`${via}\`)` },
    });
  });
};
