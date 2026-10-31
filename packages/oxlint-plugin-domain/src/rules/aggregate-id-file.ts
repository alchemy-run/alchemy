import * as path from "node:path";
import { getProperty, unwrap } from "../ast.ts";
import { domainFile, isTestFile } from "../file.ts";
import { exists, resolveImport } from "../files.ts";
import { fileNoun, naming, namingSchema } from "../naming.ts";
import type { Rule } from "../types.ts";

/**
 * SKILL.md: "An aggregate's id lives in `<Aggregate>.id.ts` next to it."
 *
 * `Account.aggregate.ts` has a sibling `Account.id.ts`, and the aggregate's
 * `id:` schema is imported from it. With `fileCase: "kebab"`,
 * `gateway-job.aggregate.ts` has a sibling `gateway-job.id.ts`.
 *
 * An aggregate keyed by a value that already exists (SKILL.md: "`UsernameClaim`
 * keyed by username") imports its `id` from that value's module
 * (`./Username.ts`, `../Account/Account.id.ts`) and needs no id file of its
 * own. Test files are skipped: a test may declare a model inline.
 */
const squash = (name: string) => name.replace(/[-_]/g, "").toLowerCase();

/** `./dog.id.ts` is the own id file of `Dog`, in another case; `./Username.ts` is not. */
const isOwnIdFile = (source: string, aggregate: string): boolean => {
  const match = /^(.*)\.id(?:\.[cm]?[jt]sx?)?$/.exec(path.basename(source));
  return match !== null && squash(match[1]!) === squash(aggregate);
};

export const aggregateIdFile: Rule = {
  meta: {
    type: "suggestion",
    docs: { description: "An aggregate's id lives in `<Aggregate>.id.ts` next to it." },
    messages: {
      missing:
        'Aggregate `{{name}}` has no `{{expected}}` next to it. Declare its id schema there (`export const {{name}}Id = Schema.String.pipe(Schema.brand("{{name}}Id"))`).',
      elsewhere:
        "Aggregate `{{name}}` takes its `id` from `{{actual}}`. Import it from `./{{expected}}`, so every block that refers to the aggregate shares one id file.",
    },
    schema: namingSchema,
  },
  create(context) {
    const { fileCase } = naming(context);
    return {
      Program(program) {
        if (isTestFile(context.filename)) return;
        const file = domainFile(context, program);
        const aggregate = file.blocks.find((block) => block.kind === "Aggregate");
        if (aggregate === undefined) return;
        const expected = `${fileNoun(aggregate.name, fileCase)}.id.ts`;
        const expectedPath = path.join(path.dirname(context.filename), expected);
        const id = getProperty(aggregate.definition, "id");
        const value = unwrap(id?.value);
        const binding = value?.type === "Identifier" ? file.imports.get(value.name) : undefined;
        if (!exists(expectedPath)) {
          if (binding !== undefined && !isOwnIdFile(binding.source, aggregate.name)) return;
          context.report({
            node: aggregate.id,
            messageId: "missing",
            data: { name: aggregate.name, expected },
          });
          return;
        }
        if (id === undefined || value?.type !== "Identifier") return;
        const source = binding?.source ?? "this file";
        const resolved = binding ? resolveImport(context.filename, binding.source) : undefined;
        if (resolved !== expectedPath) {
          context.report({
            node: id,
            messageId: "elsewhere",
            data: { name: aggregate.name, expected, actual: source },
          });
        }
      },
    };
  },
};
