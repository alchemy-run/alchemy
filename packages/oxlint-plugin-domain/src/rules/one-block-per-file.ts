import * as path from "node:path";
import { PRIMARY_SUFFIX } from "../ast.ts";
import { domainFile, isTestFile, kindOfPath } from "../file.ts";
import { fileNoun, naming, namingSchema } from "../naming.ts";
import type { Rule } from "../types.ts";

/**
 * SKILL.md: "One block per file" and "A command file holds the command, the
 * events it records, and the rejections only it returns. A rejection or event
 * used by several commands gets its own file."
 *
 * A file declares at most one aggregate, command, view, policy, saga,
 * projection, stream, external system, Api, model, request context or
 * middleware. Events and rejections may join it. A `.rejection.ts` file holds
 * one rejection. Test files are skipped: a test may declare a model inline.
 *
 * Options (shared with `block-file-name`): `fileCase` names the suggested
 * file; a `messagesFile` (`<noun>.messages.ts`) may hold several commands
 * (`block-file-name` reports any other block in it).
 */
export const oneBlockPerFile: Rule = {
  meta: {
    type: "suggestion",
    docs: { description: "One building block per file." },
    messages: {
      extra:
        "{{kind}} `{{name}}` is a second block in this file (after {{firstKind}} `{{first}}`). Give it its own `{{file}}`.",
    },
    schema: namingSchema,
  },
  create(context) {
    const { fileCase, messagesFile } = naming(context);
    return {
      Program(program) {
        if (isTestFile(context.filename)) return;
        if (
          messagesFile !== undefined &&
          path
            .basename(context.filename)
            .replace(/\.[cm]?tsx?$/, "")
            .endsWith(`.${messagesFile}`)
        ) {
          return;
        }
        const file = domainFile(context, program);
        const rejectionFile = kindOfPath(context.filename) === "Rejection";
        const counted = file.blocks.filter(
          (block) =>
            PRIMARY_SUFFIX[block.kind] !== undefined ||
            (rejectionFile && block.kind === "Rejection"),
        );
        const [first, ...rest] = counted;
        if (first === undefined) return;
        for (const block of rest) {
          context.report({
            node: block.id,
            messageId: "extra",
            data: {
              kind: block.kind,
              name: block.name,
              first: first.name,
              firstKind: first.kind,
              suffix: PRIMARY_SUFFIX[block.kind] ?? "rejection",
              file: `${fileNoun(block.name, fileCase)}.${PRIMARY_SUFFIX[block.kind] ?? "rejection"}.ts`,
            },
          });
        }
      },
    };
  },
};
