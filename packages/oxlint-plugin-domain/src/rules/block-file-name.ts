import * as path from "node:path";
import { PRIMARY_SUFFIX } from "../ast.ts";
import { domainFile, kindOfPath } from "../file.ts";
import { fileNoun, isMessageKind, naming, namingSchema } from "../naming.ts";
import type { Rule } from "../types.ts";

const TEST_FILE = /\.(?:test|spec)\.[cm]?tsx?$/;

/** `Account.aggregate.ts` → `{ noun: "Account", suffix: "aggregate" }`. */
const parse = (file: string) => {
  const base = path.basename(file).replace(/\.[cm]?tsx?$/, "");
  const dot = base.indexOf(".");
  return dot === -1
    ? { noun: base, suffix: undefined }
    : { noun: base.slice(0, dot), suffix: base.slice(dot + 1) };
};

/**
 * SKILL.md: "One block per file, named `<Noun>.<kind>.ts`. The kinds are
 * `.aggregate`, `.command`, `.view`, `.policy`, `.saga`, `.projection`,
 * `.stream`, `.external`, `.api` and `.model`. Plus `.middleware`, `.context`
 * and `.rejection`." and "A rejection or event used by several commands gets
 * its own file."
 *
 * A file's first building block names it: `class Account extends
 * Domain.Aggregate(...)` lives in `Account.aggregate.ts`. A file with only a
 * rejection is `<Rejection>.rejection.ts`. A kind-suffixed file declares a
 * block of its kind. Events and rejections may sit in their command's file.
 *
 * Options: `fileCase: "kebab"` names the file in kebab-case
 * (`withdraw-money.command.ts`); `messagesFile: "messages"` lets
 * `<noun>.messages.ts` hold the commands, events and rejections of one
 * aggregate, and nothing else.
 */
export const blockFileName: Rule = {
  meta: {
    type: "suggestion",
    docs: { description: "A building block lives in `<Noun>.<kind>.ts`, named after the block." },
    messages: {
      name: "{{kind}} `{{name}}` belongs in `{{expected}}`, not `{{actual}}`.",
      empty:
        "`{{actual}}` is named for a {{kind}}, but declares no `{{callee}}`. Rename the file, or move the block here.",
      messages:
        "`{{actual}}` holds only commands, events and rejections. Move {{kind}} `{{name}}` to `{{expected}}`.",
    },
    schema: namingSchema,
  },
  create(context) {
    const { fileCase, messagesFile } = naming(context);
    return {
      Program(program) {
        if (TEST_FILE.test(context.filename)) return;
        const file = domainFile(context, program);
        const actual = path.basename(context.filename);
        const extension = /\.([cm]?tsx?)$/.exec(actual)?.[1] ?? "ts";
        const { noun, suffix } = parse(context.filename);
        const fileOf = (name: string, kindSuffix: string) =>
          `${fileNoun(name, fileCase)}.${kindSuffix}.${extension}`;

        if (messagesFile !== undefined && suffix === messagesFile) {
          for (const block of file.blocks) {
            if (isMessageKind(block.kind)) continue;
            context.report({
              node: block.id,
              messageId: "messages",
              data: {
                kind: block.kind,
                name: block.name,
                expected: fileOf(block.name, PRIMARY_SUFFIX[block.kind] ?? "ts"),
                actual,
              },
            });
          }
          return;
        }

        const primary = file.blocks.find((block) => PRIMARY_SUFFIX[block.kind] !== undefined);
        const named =
          primary ??
          (file.blocks.length > 0 && file.blocks.every((block) => block.kind === "Rejection")
            ? file.blocks[0]
            : undefined);
        if (named !== undefined) {
          const expectedSuffix = PRIMARY_SUFFIX[named.kind] ?? "rejection";
          if (noun !== fileNoun(named.name, fileCase) || suffix !== expectedSuffix) {
            context.report({
              node: named.id,
              messageId: "name",
              data: {
                kind: named.kind,
                name: named.name,
                expected: fileOf(named.name, expectedSuffix),
                actual,
              },
            });
          }
          return;
        }

        const kind = kindOfPath(context.filename);
        if (kind === undefined) return;
        const declared = file.blocks.some((block) => block.kind === kind);
        if (!declared) {
          context.report({
            node: program,
            messageId: "empty",
            data: {
              actual,
              kind,
              callee: kind === "Middleware" ? "RpcMiddleware.Service" : `Domain.${kind}`,
            },
          });
        }
      },
    };
  },
};
