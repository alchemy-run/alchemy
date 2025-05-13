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

    const canonicalUrl = `${SITE_URL}${pagePath}`;

    // Initialize frontmatter.head if not exists
    pageData.frontmatter.head = pageData.frontmatter.head || [];

    // Add dynamic meta tags
    pageData.frontmatter.head.push(
      // Basic SEO
      ["meta", { name: "description", content: pageDescription }],

      // Open Graph
      ["meta", { property: "og:title", content: pageTitle }],
      ["meta", { property: "og:description", content: pageDescription }],
      ["meta", { property: "og:url", content: canonicalUrl }],
      ["meta", { property: "og:site_name", content: "Alchemy" }],

      // Twitter
      ["meta", { name: "twitter:card", content: "summary_large_image" }],
      ["meta", { name: "twitter:site", content: "@samgoodwin89" }],
      ["meta", { name: "twitter:title", content: pageTitle }],
      ["meta", { name: "twitter:description", content: pageDescription }],

      // Canonical URL
      ["link", { rel: "canonical", href: canonicalUrl }]
    );

    return pageData;
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
