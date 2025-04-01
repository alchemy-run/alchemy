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
          text: "Providers",
          items: [
            {
              text: "ai",
              link: "/docs/providers/ai",
              collapsed: true,
              items: [
                { text: "Document", link: "/docs/providers/ai/document" },
                { text: "Ark", link: "/docs/providers/ai/ark" },
                { text: "Information", link: "/docs/providers/ai/information" },
              ],
            },
            {
              text: "aws",
              link: "/docs/providers/aws",
              collapsed: true,
              items: [
                { text: "Function", link: "/docs/providers/aws/function" },
                { text: "Table", link: "/docs/providers/aws/table" },
                {
                  text: "Policy Attachment",
                  link: "/docs/providers/aws/policy-attachment",
                },
                { text: "Role", link: "/docs/providers/aws/role" },
                { text: "Policy", link: "/docs/providers/aws/policy" },
                { text: "Ses", link: "/docs/providers/aws/ses" },
                { text: "Bucket", link: "/docs/providers/aws/bucket" },
                { text: "Queue", link: "/docs/providers/aws/queue" },
              ],
            },
            {
              text: "cloudflare",
              link: "/docs/providers/cloudflare",
              collapsed: true,
              items: [
                { text: "State", link: "/docs/providers/cloudflare/state" },
                { text: "Bound", link: "/docs/providers/cloudflare/bound" },
                {
                  text: "Durable Object Namespace",
                  link: "/docs/providers/cloudflare/durable-object-namespace",
                },
                { text: "Zone", link: "/docs/providers/cloudflare/zone" },
                {
                  text: "Static Site",
                  link: "/docs/providers/cloudflare/static-site",
                },
                {
                  text: "Zone Settings",
                  link: "/docs/providers/cloudflare/zone-settings",
                },
                { text: "Bucket", link: "/docs/providers/cloudflare/bucket" },
                {
                  text: "KV Namespace",
                  link: "/docs/providers/cloudflare/kv-namespace",
                },
                { text: "Worker", link: "/docs/providers/cloudflare/worker" },
              ],
            },
            {
              text: "esbuild",
              link: "/docs/providers/esbuild",
              collapsed: true,
              items: [
                { text: "Bundle", link: "/docs/providers/esbuild/bundle" },
              ],
            },
            {
              text: "fs",
              link: "/docs/providers/fs",
              collapsed: true,
              items: [
                { text: "File", link: "/docs/providers/fs/file" },
                { text: "Folder", link: "/docs/providers/fs/folder" },
                { text: "Json File", link: "/docs/providers/fs/json-file" },
                { text: "Text File", link: "/docs/providers/fs/text-file" },
                {
                  text: "TypeScript File",
                  link: "/docs/providers/fs/typescript-file",
                },
                { text: "Yaml File", link: "/docs/providers/fs/yaml-file" },
              ],
            },
            {
              text: "github",
              link: "/docs/providers/github",
              collapsed: true,
              items: [
                { text: "Secret", link: "/docs/providers/github/secret" },
              ],
            },
            {
              text: "stripe",
              link: "/docs/providers/stripe",
              collapsed: true,
              items: [
                { text: "Price", link: "/docs/providers/stripe/price" },
                { text: "Product", link: "/docs/providers/stripe/product" },
                { text: "Webhook", link: "/docs/providers/stripe/webhook" },
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
