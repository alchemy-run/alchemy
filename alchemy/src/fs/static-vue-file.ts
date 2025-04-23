import { File } from "./file.js";

export type StaticVueFile = File;

/**
 * Creates a static Vue component file
 *
 * @example
 * // Create a Vue component file with content
 * const button = await StaticVueFile("Button.vue",
 *   `<template>
 *     <button class="btn">{{ text }}</button>
 *   </template>
 *
 *   <script>
 *   export default {
 *     props: {
 *       text: String
 *     }
 *   }
 *   </script>
 *
 *   <style>
 *   .btn {
 *     padding: 0.5rem 1rem;
 *   }
 *   </style>`
 * );
 */
export function StaticVueFile(
  id: string,
  ...args: [content: string] | [path: string, content: string]
): Promise<StaticVueFile> {
  const [path, content] = args.length === 1 ? [id, args[0]] : args;
  return File(id, {
    path,
    content,
  });
}
