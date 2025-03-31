import { transformerTwoslash } from "@shikijs/vitepress-twoslash";
import footnotePlugin from "markdown-it-footnote";
import { defineConfig } from "vitepress";

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "Alchemy",
  description: "Alchemy is a TypeScript-native, embeddable IaC library",
  markdown: {
    // @ts-ignore
    codeTransformers: [transformerTwoslash()],
    theme: { light: "light-plus", dark: "dark-plus" },
    config: (md) => md.use(footnotePlugin),
  },
  // https://vitepress.dev/reference/default-theme-config
  themeConfig: {
    search: { provider: "local" },
    nav: [
      { text: "Docs", link: "/docs" },
      { text: "Examples", link: "/examples" },
    ],
    sidebar: {
      "/blog/": [{ text: "Blog", items: [{ text: "Foo", link: "/blog/foo" }] }],
      "/docs/": [{ text: "Docs", items: [{ text: "Foo", link: "/docs/foo" }] }],
      "/examples/": [
        { text: "Examples", items: [{ text: "Foo", link: "/examples/foo" }] },
      ],
      "/": [
        {
          text: "Home",
          items: [
            { text: "Markdown Examples", link: "/markdown-examples" },
            { text: "Runtime API Examples", link: "/api-examples" },
          ],
        },
      ],
    },
    socialLinks: [],
  },
});
