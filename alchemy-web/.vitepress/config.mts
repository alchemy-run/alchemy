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
        {
          text: "Resources",
          items: [
            {
              text: "AWS",
              link: "/docs/aws",
              collapsed: true,
              items: [
                { text: "Bucket", link: "/docs/aws/bucket" },
                { text: "Function", link: "/docs/aws/function" },
                { text: "Policy", link: "/docs/aws/policy" },
                { text: "Queue", link: "/docs/aws/queue" },
                { text: "Simple Email Service", link: "/docs/aws/ses" },
                { text: "Table", link: "/docs/aws/table" },
              ],
            },
            {
              text: "Cloudflare",
              link: "/docs/cloudflare",
              collapsed: true,
              items: [
                { text: "Bucket", link: "/docs/cloudflare/bucket" },
                {
                  text: "Durable Object",
                  link: "/docs/cloudflare/durable-object",
                },
                { text: "KV Namespace", link: "/docs/cloudflare/kv-namespace" },
                { text: "Static Site", link: "/docs/cloudflare/static-site" },
                { text: "Worker", link: "/docs/cloudflare/worker" },
                { text: "Zone", link: "/docs/cloudflare/zone" },
              ],
            },
            {
              text: "File System",
              link: "/docs/fs",
              collapsed: true,
              items: [
                { text: "File", link: "/docs/fs/file" },
                { text: "Folder", link: "/docs/fs/folder" },
              ],
            },
            {
              text: "GitHub",
              link: "/docs/github",
              collapsed: true,
              items: [{ text: "Secret", link: "/docs/github/secret" }],
            },
            {
              text: "Stripe",
              link: "/docs/stripe",
              collapsed: true,
              items: [
                { text: "Product", link: "/docs/stripe/product" },
                { text: "Price", link: "/docs/stripe/price" },
              ],
            },
          ],
        },
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
