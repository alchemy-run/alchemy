import { transformerTwoslash } from "@shikijs/vitepress-twoslash";
import fs from "fs";
import footnotePlugin from "markdown-it-footnote";
import path from "path";
import { defineConfig } from "vitepress";
import {
  groupIconMdPlugin,
  groupIconVitePlugin,
} from "vitepress-plugin-group-icons";
import { processFrontmatterFiles } from "../../alchemy/src/web/vitepress";

// Imports for OG Image Generation
import { generateOgImage } from "./theme/og-generator";

const description = "Alchemy: Typescript-native Infrastructure-as-Code";
const SITE_URL = "https://alchemy.run";

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "Alchemy",
  description: "Alchemy Docs",
  head: [
    ["link", { rel: "icon", type: "image/png", href: "/potion.png" }],
    ["meta", { property: "og:type", content: "website" }],
    // Base meta tags are now added by transformPageData
  ],
  markdown: {
    // @ts-ignore
    codeTransformers: [transformerTwoslash()],
    theme: { light: "light-plus", dark: "dark-plus" },
    config: (md) => md.use(footnotePlugin).use(groupIconMdPlugin),
  },
  vite: {
    plugins: [groupIconVitePlugin() as any],
  },
  // https://vitepress.dev/reference/default-theme-config
  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "Docs", link: "/docs/getting-started" },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/sam-goodwin/alchemy" },
      { icon: "discord", link: "https://discord.gg/jwKw8dBJdN" },
      { icon: "x", link: "https://twitter.com/samgoodwin89" },
    ],
    sidebar: [
      { text: "Get Started", link: "/docs/getting-started" },
      { text: "What is Alchemy?", link: "/docs/what-is-alchemy" },
      await generateSidebar("Guides"),
      await generateSidebar("Concepts"),
      await generateProvidersSidebar(),
    ],
    search: { provider: "local" },
  },
  // Add transformPageData hook for dynamic meta tags
  transformPageData(pageData) {
    // Get page-specific details
    const pageTitle = pageData.title || "Alchemy";
    const pageDescription = pageData.frontmatter?.description || description;

    // Generate canonical URL
    let pagePath = pageData.filePath
      ? "/" +
        path
          .relative(path.join(process.cwd()), pageData.filePath)
          .replace(/^alchemy-web\//, "")
          .replace(/\.(md|html)$/, "")
      : "/";

    // Handle index files
    pagePath = pagePath.replace(/\/index$/, "/");
    // Ensure consistent path normalization (use forward slashes)
    pagePath = pagePath.replace(/\\/g, "/");

    const canonicalUrl = `${SITE_URL}${pagePath}`;

    // Initialize frontmatter.head if not exists
    pageData.frontmatter.head = pageData.frontmatter.head || [];

    // --- OG Image Path Calculation (consistent with buildEnd) ---
    const relativeMdPath = path.relative(
      path.join(process.cwd()),
      pageData.filePath
    );

    // Determine directory (docs or blogs) and file path
    let dir = "docs";
    let filePath = relativeMdPath.replace(/^alchemy-web\//, "");

    if (filePath.startsWith("blogs/")) {
      dir = "blogs";
      filePath = filePath.replace(/^blogs\//, "");
    } else if (filePath.startsWith("docs/")) {
      filePath = filePath.replace(/^docs\//, "");
    }

    // Generate image slug matching the buildEnd function logic
    let imageSlug = `${dir}-${filePath}`.replace(/\.md$/, "");

    if (imageSlug.endsWith("/index")) {
      imageSlug = imageSlug.substring(0, imageSlug.lastIndexOf("/index"));
    } else if (imageSlug.endsWith("index")) {
      imageSlug = imageSlug.replace(/index$/, "home");
    }

    imageSlug = imageSlug.replace(/\//g, "-").replace(/^-|-$/, "");
    const finalImageSlug = imageSlug === "" ? "home" : imageSlug;

    // Ensure URL is properly formatted with double slashes after protocol
    // Use a proper URL construction to avoid incorrect replacements
    const imageSlugForUrl = finalImageSlug || "placeholder";
    const ogImageUrl = new URL(
      `/og-images/${imageSlugForUrl}.png`,
      SITE_URL
    ).toString();
    // --- End OG Image Path Calculation ---

    // Add dynamic meta tags
    pageData.frontmatter.head.push(
      // Basic SEO
      ["meta", { name: "description", content: pageDescription }],

      // Open Graph
      ["meta", { property: "og:title", content: pageTitle }],
      ["meta", { property: "og:description", content: pageDescription }],
      ["meta", { property: "og:url", content: canonicalUrl }],
      ["meta", { property: "og:site_name", content: "Alchemy" }],
      ["meta", { property: "og:image", content: ogImageUrl }],
      ["meta", { property: "og:image:width", content: "1200" }],
      ["meta", { property: "og:image:height", content: "630" }],

      // Twitter
      ["meta", { name: "twitter:card", content: "summary_large_image" }],
      ["meta", { name: "twitter:site", content: "@samgoodwin89" }],
      ["meta", { name: "twitter:title", content: pageTitle }],
      ["meta", { name: "twitter:description", content: pageDescription }],
      ["meta", { name: "twitter:image", content: ogImageUrl }],

      // Canonical URL
      ["link", { rel: "canonical", href: canonicalUrl }]
    );

    return pageData;
  },

  async buildEnd(siteConfig) {
    console.log("Generating OG images...");

    // Directory for OG images
    const publicOgDir = path.join("public/og-images");

    // Ensure the public/og-images directory exists
    await fs.promises.mkdir(publicOgDir, { recursive: true });

    // Process both docs and blogs directories
    const baseDirs = ["docs", "blogs"];
    let fileCount = 0;

    for (const dir of baseDirs) {
      // Process files for this directory
      await processDirectory(dir, "", publicOgDir);
    }

    console.log(`OG image generation complete. Processed ${fileCount} files.`);

    // Function to recursively process directories
    async function processDirectory(
      baseDir: string,
      relativePath: string,
      outputDir: string
    ) {
      const fullPath = path.join(baseDir, relativePath);

      // Skip if directory doesn't exist (like if there's no blogs directory)
      if (!fs.existsSync(fullPath)) {
        return;
      }

      const entries = fs.readdirSync(fullPath, { withFileTypes: true });

      for (const entry of entries) {
        const entryRelativePath = path.join(relativePath, entry.name);
        const entryFullPath = path.join(baseDir, entryRelativePath);

        if (entry.isDirectory()) {
          // Recursively process subdirectories
          await processDirectory(baseDir, entryRelativePath, outputDir);
        } else if (entry.name.endsWith(".md")) {
          // Process markdown files
          fileCount++;

          // Read the file content
          const fileContent = await fs.promises.readFile(
            entryFullPath,
            "utf-8"
          );

          // Simple frontmatter extraction (replaces gray-matter)
          const frontmatter = extractFrontmatter(fileContent);

          const pageTitleRaw =
            frontmatter.title || path.basename(entry.name, ".md");
          // A simple title case, adjust if more complex logic is needed
          const pageTitle = pageTitleRaw
            .replace(/-/g, " ")
            .replace(/\b\w/g, (l) => l.toUpperCase());
          const pageDescription = frontmatter.description;

          if (!pageTitle) {
            console.warn(
              `Skipping OG image for ${entryFullPath}: title missing or could not be derived.`
            );
            continue;
          }

          // Consistent slug generation including directory prefix
          let filePath = entryRelativePath;
          let imageSlug = `${baseDir}-${filePath}`.replace(/\.md$/, "");

          if (imageSlug.endsWith("/index")) {
            imageSlug = imageSlug.substring(0, imageSlug.lastIndexOf("/index"));
          } else if (imageSlug.endsWith("index")) {
            imageSlug = imageSlug.replace(/index$/, "home");
          }

          imageSlug = imageSlug.replace(/\//g, "-").replace(/^-|-$/, "");
          const finalImageSlug = imageSlug === "" ? "home" : imageSlug;

          const ogImageFileName = `${finalImageSlug}.png`;
          const ogImagePath = path.join(outputDir, ogImageFileName);

          console.log(`Processing ${entryFullPath} -> ${ogImageFileName}`);

          try {
            await generateOgImage(pageTitle, pageDescription, ogImagePath);
          } catch (error) {
            console.error(
              `Failed to generate OG image for ${entryFullPath}:`,
              error
            );
          }
        }
      }
    }

    // Simple function to extract frontmatter from markdown
    function extractFrontmatter(content: string) {
      const result: Record<string, any> = {};

      // Check if file has frontmatter (between --- markers)
      const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);

      if (!match) {
        return result;
      }

      const frontmatterText = match[1];

      // Parse frontmatter lines
      frontmatterText.split("\n").forEach((line) => {
        // Look for "key: value" patterns
        const colonIndex = line.indexOf(":");
        if (colonIndex > 0) {
          const key = line.slice(0, colonIndex).trim();
          const value = line.slice(colonIndex + 1).trim();

          // Remove quotes if present
          result[key] = value.replace(/^['"](.*)['"]$/, "$1");
        }
      });

      return result;
    }
  },
});

async function generateSidebar(title: string) {
  const folder = title.toLowerCase();
  return {
    text: title,
    collapsed: false,
    items: await processFrontmatterFiles(`docs/${folder}`, `/docs/${folder}`),
  };
}

/**
 * Generate sidebar items for providers by traversing the file system
 */
async function generateProvidersSidebar() {
  const providersDir = path.join(process.cwd(), "docs/providers");
  const providers = fs
    .readdirSync(providersDir)
    .filter((dir) => fs.statSync(path.join(providersDir, dir)).isDirectory())
    .sort();

  const items = await Promise.all(
    providers.map(async (provider) => {
      const providerDir = path.join(providersDir, provider);
      const files = fs
        .readdirSync(providerDir)
        .filter((file) => file.endsWith(".md"))
        .sort();

      const fileItems = files.map((file) => {
        // Convert filename to display text (e.g., astro-file.md -> AstroFile)
        const baseName = path.basename(file, ".md");
        const displayName = baseName
          .split("-")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join("");

        return {
          text: displayName,
          link: `/docs/providers/${provider}/${baseName}`,
        };
      });

      return {
        text: provider,
        collapsed: true,
        items: fileItems,
      };
    })
  );

  return {
    text: "Providers",
    collapsed: false,
    items,
  };
}
