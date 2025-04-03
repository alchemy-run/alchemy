import { transformerTwoslash } from "@shikijs/vitepress-twoslash";
import footnotePlugin from "markdown-it-footnote";
import { defineConfig } from "vitepress";

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "Alchemy",
  description: "Alchemy Docs",
  markdown: {
    // @ts-ignore
    codeTransformers: [transformerTwoslash()],
    theme: { light: "light-plus", dark: "dark-plus" },
    config: (md) => md.use(footnotePlugin),
  },
  // https://vitepress.dev/reference/default-theme-config
  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "Docs", link: "/docs/getting-started" },
    ],
    sidebar: [
      { text: "Getting Started", link: "/docs/getting-started" },
      {
        text: "Providers",
        link: "/docs/providers",
        collapsed: false,
        items: [
          {
            text: "web",
            collapsed: true,
            items: [
              { text: "ViteProject", link: "/docs/providers/web/vite.md" },
              { text: "AstroProject", link: "/docs/providers/web/astro.md" },
              {
                text: "ShadcnComponent",
                link: "/docs/providers/web/shadcn-component.md",
              },
              {
                text: "TailwindConfig",
                link: "/docs/providers/web/tailwind.md",
              },
              { text: "ShadcnUI", link: "/docs/providers/web/shadcn.md" },
            ],
          },
        ],
      },
    ],
    search: { provider: "local" },
    socialLinks: [],
  },
});
