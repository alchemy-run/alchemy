import { transformerTwoslash } from "@shikijs/vitepress-twoslash";
import footnotePlugin from "markdown-it-footnote";
import { defineConfig } from "vitepress";

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "Alchemy",
  description: "Alchemy is an TypeScript-native, embeddable IaC library",
  markdown: {
    // @ts-ignore
    codeTransformers: [transformerTwoslash()],
    theme: { light: "light-plus", dark: "dark-plus" },
    config: (md) => md.use(footnotePlugin),
  },
  // https://vitepress.dev/reference/default-theme-config
  themeConfig: {
    sidebar: {
      "/blog/": [{ text: "Blog", items: [{ text: "Blog", link: "/blog/" }] }],
      "/docs/": [
        {
          text: "Getting Started",
          items: [{ text: "Install", link: "/docs/getting-started/install" }],
        },
        {
          text: "Guides",
          items: [
            { text: "Custom Resource", link: "/docs/guides/custom-resource" },
            { text: "Automating with LLMs", link: "/docs/guides/llms" },
          ],
        },
        {
          text: "Core",
          collapsed: true,
          items: [
            { text: "App", link: "/docs/core/app" },
            { text: "Resource", link: "/docs/core/resource" },
            { text: "Scope", link: "/docs/core/scope" },
            { text: "Phase", link: "/docs/core/phase" },
            { text: "Finalize", link: "/docs/core/finalize" },
            { text: "State", link: "/docs/core/state" },
            { text: "Secret", link: "/docs/core/secret" },
            { text: "Context", link: "/docs/core/context" },
          ],
        },
        { text: "Providers", items: [] },
      ],
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
    socialLinks: [
      { icon: "github", link: "https://github.com/sam-goodwin/alchemy" },
    ],
    search: { provider: "local" },
    nav: [{ text: "Home", link: "/" }],
  },
});
