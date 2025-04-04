import { File } from "./file";

export type StaticAstroFile = File;

/**
 * Creates a static Astro component file
 *
 * @example
 * // Create an Astro component file with content
 * const header = await StaticAstroFile("Header.astro",
 *   `---
 *   import Logo from '../components/Logo.astro';
 *   const navItems = ['Home', 'About', 'Contact'];
 *   ---
 *
 *   <header class="header">
 *     <Logo />
 *     <nav>
 *       <ul>
 *         {navItems.map(item => (
 *           <li><a href={`/${item.toLowerCase()}`}>{item}</a></li>
 *         ))}
 *       </ul>
 *     </nav>
 *   </header>
 *
 *   <style>
 *     .header {
 *       display: flex;
 *       justify-content: space-between;
 *       padding: 1rem;
 *     }
 *   </style>`
 * );
 */
export function StaticAstroFile(
  id: string,
  ...args: [content: string] | [path: string, content: string]
): Promise<StaticAstroFile> {
  const [path, content] = args.length === 1 ? [id, args[0]] : args;
  return File(id, {
    path,
    content,
  });
}
