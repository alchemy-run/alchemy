import { arrayIdentifiers, getProperty } from "../ast.ts";
import { domainFile } from "../file.ts";
import { packageRoot, storyText } from "../files.ts";
import type { Rule } from "../types.ts";

const escape = (name: string) => name.replace(/[$]/g, "\\$");

/** `new X(`, `new X<...>(` or `X.make(`. */
const built = (name: string) =>
  new RegExp(`\\bnew\\s+${escape(name)}\\s*[(<]|\\b${escape(name)}\\.make\\s*\\(`);

/**
 * SKILL.md: "Write stories for the happy path, every rejection, and every
 * policy reaction." and testing.md: "For every command, cover the happy path,
 * each rejection ...".
 *
 * Every command and every rejection declared in a file appears in at least one
 * story of its package (a test file that imports `@alchemy.run/domain/Story`):
 * a command is sent (`new X(`) or one of its `events` is built (a command that
 * only a policy or saga sends shows up through its events); a rejection is
 * built (`Story.rejected(new X(...))`). The rule reads the story files' text,
 * so it does not tell `given` from `then`, and does not see which branches run.
 */
export const storyCoverage: Rule = {
  meta: {
    type: "suggestion",
    docs: { description: "Every command and every rejection appears in a story." },
    messages: {
      command:
        "No story sends the command `{{name}}` or shows one of its events. Add a story for its happy path (`Story.when(ref, new {{name}}(...))`) and for each rejection.",
      rejection:
        "No story asserts the rejection `{{name}}`. Add a story that ends in `Story.rejected(new {{name}}(...))`.",
    },
  },
  create(context) {
    return {
      Program(program) {
        const file = domainFile(context, program);
        const blocks = file.blocks.filter(
          (block) => block.kind === "Command" || block.kind === "Rejection",
        );
        if (blocks.length === 0) return;
        const root = packageRoot(context.filename);
        if (root === undefined) return;
        const stories = storyText(root);
        for (const block of blocks) {
          const names =
            block.kind === "Command"
              ? [
                  block.name,
                  ...arrayIdentifiers(getProperty(block.definition, "events")?.value).map(
                    (id) => id.name,
                  ),
                ]
              : [block.name];
          const used = names.some((name) => built(name).test(stories));
          if (!used) {
            context.report({
              node: block.id,
              messageId: block.kind === "Command" ? "command" : "rejection",
              data: { name: block.name },
            });
          }
        }
      },
    };
  },
};
