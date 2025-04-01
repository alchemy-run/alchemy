import { File } from "./file";

/**
 * Creates a TypeScript file with formatted content using prettier
 *
 * @example
 * // Create a TypeScript file
 * const component = await TypeScriptFile("Component.ts", `
 *   interface Props {
 *     name: string;
 *     age: number;
 *   }
 *
 *   export function Component({ name, age }: Props) {
 *     return <div>Hello {name}, you are {age} years old</div>;
 *   }
 * `);
 */
export type TypeScriptFile = File;

export async function TypeScriptFile(
  id: string,
  content: string,
): Promise<TypeScriptFile> {
  const prettier = await import("prettier");
  return File(id, {
    path: id,
    content: await prettier.format(content, {
      parser: "typescript",
      editor: {
        tabWidth: 2,
        indentWidth: 2,
      },
    }),
  });
}
