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
            text: "ai",
            collapsed: true,
            items: [
              { text: "Astro File", link: "/docs/providers/ai/astro-file.md" },
              { text: "CSS File", link: "/docs/providers/ai/css-file.md" },
              { text: "Data", link: "/docs/providers/ai/data.md" },
              { text: "Document", link: "/docs/providers/ai/document.md" },
              { text: "HTML File", link: "/docs/providers/ai/html-file.md" },
              { text: "JSON File", link: "/docs/providers/ai/json-file.md" },
              {
                text: "TypeScript File",
                link: "/docs/providers/ai/typescript-file.md",
              },
              { text: "Vue File", link: "/docs/providers/ai/vue-file.md" },
              { text: "YAML File", link: "/docs/providers/ai/yaml-file.md" },
            ],
          },
          {
            text: "aws",
            collapsed: true,
            items: [
              { text: "Bucket", link: "/docs/providers/aws/bucket.md" },
              { text: "Function", link: "/docs/providers/aws/function.md" },
              { text: "Policy", link: "/docs/providers/aws/policy.md" },
              {
                text: "Policy Attachment",
                link: "/docs/providers/aws/policy-attachment.md",
              },
              { text: "Queue", link: "/docs/providers/aws/queue.md" },
              { text: "Role", link: "/docs/providers/aws/role.md" },
              { text: "SES", link: "/docs/providers/aws/ses.md" },
              { text: "Table", link: "/docs/providers/aws/table.md" },
            ],
          },
          {
            text: "cloudflare",
            collapsed: true,
            items: [
              { text: "Bound", link: "/docs/providers/cloudflare/bound.md" },
              { text: "Bucket", link: "/docs/providers/cloudflare/bucket.md" },
              { text: "Dns", link: "/docs/providers/cloudflare/dns.md" },
              {
                text: "Durable Object Namespace",
                link: "/docs/providers/cloudflare/durable-object-namespace.md",
              },
              {
                text: "Kv Namespace",
                link: "/docs/providers/cloudflare/kv-namespace.md",
              },
              {
                text: "R2 Rest State Store",
                link: "/docs/providers/cloudflare/r2-rest-state-store.md",
              },
              {
                text: "Static Site",
                link: "/docs/providers/cloudflare/static-site.md",
              },
              { text: "Worker", link: "/docs/providers/cloudflare/worker.md" },
              { text: "Zone", link: "/docs/providers/cloudflare/zone.md" },
              {
                text: "Zone Settings",
                link: "/docs/providers/cloudflare/zone-settings.md",
              },
            ],
          },
          {
            text: "dns",
            collapsed: true,
            items: [
              {
                text: "Import Dns Records",
                link: "/docs/providers/dns/import-dns.md",
              },
            ],
          },
          {
            text: "esbuild",
            collapsed: true,
            items: [
              { text: "Bundle", link: "/docs/providers/esbuild/bundle.md" },
            ],
          },
          {
            text: "fs",
            collapsed: true,
            items: [
              { text: "Copy File", link: "/docs/providers/fs/copy-file.md" },
              { text: "File", link: "/docs/providers/fs/file.md" },
              { text: "Folder", link: "/docs/providers/fs/folder.md" },
              {
                text: "Static Json File",
                link: "/docs/providers/fs/static-json-file.md",
              },
              {
                text: "Static Text File",
                link: "/docs/providers/fs/static-text-file.md",
              },
              {
                text: "Static Type Script File",
                link: "/docs/providers/fs/static-typescript-file.md",
              },
              {
                text: "Static Yaml File",
                link: "/docs/providers/fs/static-yaml-file.md",
              },
            ],
          },
          {
            text: "github",
            collapsed: true,
            items: [
              {
                text: "GitHub Secret",
                link: "/docs/providers/github/secret.md",
              },
            ],
          },
          {
            text: "stripe",
            collapsed: true,
            items: [
              { text: "Price", link: "/docs/providers/stripe/price.md" },
              { text: "Product", link: "/docs/providers/stripe/product.md" },
              {
                text: "WebhookEndpoint",
                link: "/docs/providers/stripe/webhook.md",
              },
            ],
          },
        ],
      },
    ],
    search: { provider: "local" },
    socialLinks: [],
  },
});
