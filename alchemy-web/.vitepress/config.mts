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
      { text: "Blogs", link: "/blogs/" },
    ],
    sidebar: [
      { text: "Get Started", link: "/docs/getting-started" },
      { text: "What is Alchemy?", link: "/docs/what-is-alchemy" },
      {
        text: "Concepts",
        link: "/docs/concepts",
        collapsed: false,
        items: [
          { text: "Resource", link: "/docs/concepts/resource.md" },
          { text: "Scope", link: "/docs/concepts/scope.md" },
          { text: "State", link: "/docs/concepts/state.md" },
          { text: "Bindings", link: "/docs/concepts/bindings.md" },
          { text: "Secrets", link: "/docs/concepts/secrets.md" },
          { text: "Testing", link: "/docs/concepts/testing.md" },
        ],
      },
      {
        text: "Tutorials",
        collapsed: true,
        items: [
          {
            text: "Deploying a Cloudflare Worker and Static Site",
            link: "/docs/tutorials/deploy-cloudflare-worker-and-static-site.md",
          },
          {
            text: "Bundling and Deploying an AWS Lambda Function",
            link: "/docs/tutorials/deploy-aws-lambda-function.md",
          },
          {
            text: "Create a Custom Resource with AI",
            link: "/docs/tutorials/writing-custom-resource.md",
          },
        ],
      },
      {
        text: "Providers",
        link: "/docs/providers",
        collapsed: false,
        items: [],
      },
    ],
    search: { provider: "local" },
    socialLinks: [],
  },
});
