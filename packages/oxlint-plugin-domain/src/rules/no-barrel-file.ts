import type { Rule } from "../types.ts";

/**
 * layout.md: "Don't add barrel files." Each package exports its files by path,
 * so imports name the file they come from.
 */
export const noBarrelFile: Rule = {
  meta: {
    type: "suggestion",
    docs: { description: "No barrel files: a file that only re-exports other files." },
    messages: {
      barrel:
        "This file only re-exports other files. Don't add barrel files: import each block from its own file (`@acme/domain/Account/Account.aggregate`).",
    },
  },
  create(context) {
    return {
      Program(program) {
        const statements = program.body.filter(
          (statement: { type: string }) =>
            statement.type !== "EmptyStatement" && statement.type !== "ImportDeclaration",
        );
        const reexports = statements.filter(
          (statement: { type: string; source?: unknown }) =>
            (statement.type === "ExportAllDeclaration" ||
              statement.type === "ExportNamedDeclaration") &&
            statement.source != null,
        );
        if (reexports.length > 0 && reexports.length === statements.length) {
          context.report({ node: program, messageId: "barrel" });
        }
      },
    };
  },
};
