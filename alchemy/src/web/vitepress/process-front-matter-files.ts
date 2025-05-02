import fs from "node:fs/promises";
import path from "node:path";

/**
 * Process markdown files with frontmatter to generate navigation items
 * @param directoryPath The directory containing markdown files
 * @param linkPrefix The prefix for navigation links
 * @returns Sorted array of navigation items with text and link properties
 */
export async function processFrontmatterFiles(
  directoryPath: string,
  linkPrefix: string,
): Promise<
  {
    text: string;
    link: string;
    items?: {
      text: string;
      link: string;
      items?: { text: string; link: string }[];
    }[];
  }[]
> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });

  const processedEntries = await Promise.all(
    entries
      .filter((entry) => !entry.name.endsWith("index.md"))
      .map(async (entry) => {
        const fullPath = path.join(directoryPath, entry.name);

        if (entry.isDirectory()) {
          // Process subdirectory recursively
          const items = await processFrontmatterFiles(
            fullPath,
            `${linkPrefix}/${entry.name}`,
          );

          // Create section for subdirectory
          return {
            text: entry.name.charAt(0).toUpperCase() + entry.name.slice(1),
            collapsed: false,
            items,
            order: 10000, // Default order for directories
          };
        }

        // Process markdown file
        if (!entry.name.endsWith(".md")) {
          return null;
        }

        const content = await fs.readFile(fullPath, "utf-8");
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        let order = 10000;
        let title;

        if (frontmatterMatch) {
          const frontmatter = frontmatterMatch[1];
          const orderMatch = frontmatter.match(/order:\s*(\d+)/);
          if (orderMatch) {
            order = Number.parseFloat(orderMatch[1]);
          }
          const titleMatch = frontmatter.match(/title:\s*(.+)/);
          if (titleMatch) {
            title = titleMatch[1].trim();
          }
        }

        // If no title in frontmatter, try to get first heading
        if (!title) {
          const headingMatch = content.match(/^#\s+(.+)$/m);
          if (headingMatch) {
            title = headingMatch[1].trim();
          }
        }

        // Fall back to filename if no title found
        if (!title) {
          const name = entry.name.replace(".md", "");
          title = name.charAt(0).toUpperCase() + name.slice(1);
        }

        return {
          text: title,
          link: `${linkPrefix}/${entry.name}`,
          order,
        };
      }),
  );

  // Filter out null entries and sort by order
  return processedEntries
    .filter((entry) => entry !== null)
    .sort((a, b) => a.order - b.order)
    .map(({ text, link, items }) =>
      items ? { text, items, collapsed: true } : { text, link },
    ) as any;
}
