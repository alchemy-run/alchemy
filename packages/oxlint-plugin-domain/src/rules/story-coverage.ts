import { type Block, arrayIdentifiers, getProperty, propertyName, unwrap } from "../ast.ts";
import { domainFile } from "../file.ts";
import { packageRoot, storyRejections, storyText } from "../files.ts";
import type { Node, Rule } from "../types.ts";

const escape = (name: string) => name.replace(/[$]/g, "\\$");

/** `new X(`, `new X<...>(` or `X.make(`. */
const built = (name: string) =>
  new RegExp(`\\bnew\\s+${escape(name)}\\s*[(<]|\\b${escape(name)}\\.make\\s*\\(`);

/**
 * A `fail` (stubbed call) or `failed` (real call) step for `System.op`, untagged or
 * tagged: `Story.fail(Payments.refund, ...)`, `fail("r-2", Payments.refund, ...)`.
 */
const failStep = (system: string, op: string) =>
  new RegExp(
    `\\bfail(?:ed)?\\s*\\(\\s*(?:(["'\`])[^"'\`]*\\1\\s*,\\s*)?${escape(system)}\\s*\\.\\s*${escape(op)}\\b`,
  );

/** The ops of an external system that declare an `error:` by name: `[op, error]`. */
const declaredErrors = (block: Block): Array<readonly [string, string, Node]> => {
  const ops = block.definition?.properties ?? [];
  return ops.flatMap((property: Node) => {
    const op = propertyName(property);
    const error = getProperty(property.value, "error");
    const value = unwrap(error?.value);
    return op !== undefined && value?.type === "Identifier"
      ? [[op, value.name, error!] as const]
      : [];
  });
};

/**
 * SKILL.md: "Write stories for the happy path, every rejection, and every
 * policy reaction." and testing.md: "For every command, cover the happy path,
 * each rejection ... For every policy, cover the reaction, the reaction when
 * its command is rejected, and the reaction when an external call fails with
 * its declared error."
 *
 * Each block declared in a file appears in at least one story of its package
 * (a test file that imports `@alchemy.run/domain/Story`):
 *
 * - a command is sent (`new X(`), or one of its `events` is built (a command
 *   that only a policy or saga sends shows up through its events);
 * - a rejection that a command or a saga lists in `rejects` is built
 *   (`Story.rejected(new X(...))`, a saga's `Rejected` status). A rejection
 *   only a view or a read returns is skipped: its `validate` runs in Api tests;
 * - each error an external system op declares is built, and a story fails
 *   that op (`Story.fail(System.op, new X(...))` for a stubbed system,
 *   `Story.failed(...)` for a real one).
 *
 * The rule reads the story files' text, so it does not tell `given` from
 * `then`, and does not see which branches run.
 */
export const storyCoverage: Rule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Every command, rejection and declared external error appears in a story.",
    },
    messages: {
      command:
        "No story sends the command `{{name}}` or shows one of its events. Add a story for its happy path (`Story.when(ref, new {{name}}(...))`) and for each rejection.",
      rejection:
        "No story asserts the rejection `{{name}}`. Add a story that ends in `Story.rejected(new {{name}}(...))`.",
      error:
        "No story fails `{{system}}.{{op}}` with its declared error `{{name}}`. Add one with `Story.fail({{system}}.{{op}}, new {{name}}(...))` (a stubbed system) or `Story.failed(...)` (a real one).",
    },
  },
  create(context) {
    return {
      Program(program) {
        const file = domainFile(context, program);
        const blocks = file.blocks.filter(
          (block) =>
            block.kind === "Command" ||
            block.kind === "Rejection" ||
            block.kind === "ExternalSystem",
        );
        if (blocks.length === 0) return;
        const root = packageRoot(context.filename);
        if (root === undefined) return;
        const stories = storyText(root);

        // Rejections a story can assert: listed by a command or saga here, or in another file.
        const assertable = new Set<string>();
        for (const block of file.blocks) {
          if (block.kind === "Command" || block.kind === "Saga") {
            file.rejectsOf(block.name)?.forEach((name) => assertable.add(name));
          }
        }
        for (const [other, names] of storyRejections(root)) {
          if (other !== context.filename) names.forEach((name) => assertable.add(name));
        }

        for (const block of blocks) {
          if (block.kind === "ExternalSystem") {
            for (const [op, error, node] of declaredErrors(block)) {
              if (built(error).test(stories) && failStep(block.name, op).test(stories)) continue;
              context.report({
                node,
                messageId: "error",
                data: { system: block.name, op, name: error },
              });
            }
            continue;
          }
          if (block.kind === "Rejection" && !assertable.has(block.name)) continue;
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
