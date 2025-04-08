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
    socialLinks: [
      { icon: "github", link: "https://github.com/sam-goodwin/alchemy" },
      { icon: "x", link: "https://twitter.com/samgoodwin89" },
    ],
    search: { provider: "local" },
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
          { text: "Secret", link: "/docs/concepts/secret.md" },
          { text: "Testing", link: "/docs/concepts/testing.md" },
          { text: "Destroy", link: "/docs/concepts/destroy.md" },
          { text: "Bindings", link: "/docs/concepts/bindings.md" },
        ],
      },
      {
        text: "Guides",
        link: "/guides",
        collapsed: false,
        items: [
          { text: "Custom Resource", link: "/docs/guides/custom-resources.md" },
          {
            text: "Custom State Store",
            link: "/docs/guides/custom-state-store.md",
          },
          {
            text: "Cloudflare",
            items: [
              {
                text: "Deploy ViteJS Static Site",
                link: "/docs/guides/cloudflare/vitejs.md",
              },
              {
                text: "Workers and Bindings",
                link: "/docs/guides/cloudflare/worker.md",
              },
              {
                text: "Durable Object",
                link: "/docs/guides/cloudflare/durable-object.md",
              },
              { text: "DNS & Zone", link: "/docs/guides/cloudflare/zone.md" },
            ],
            collapsed: true,
          },
        ],
      },
      {
        text: "Providers",
        link: "/docs/providers",
        collapsed: false,
        items: [
          {
            text: "ai",
            collapsed: true,
            items: [
              { text: "Astro-file", link: "/docs/providers/ai/astro-file.md" },
              { text: "Css-file", link: "/docs/providers/ai/css-file.md" },
              { text: "Data", link: "/docs/providers/ai/data.md" },
              { text: "Document", link: "/docs/providers/ai/document.md" },
              { text: "Html-file", link: "/docs/providers/ai/html-file.md" },
              {
                text: "Typescript-file",
                link: "/docs/providers/ai/typescript-file.md",
              },
              { text: "Vue-file", link: "/docs/providers/ai/vue-file.md" },
              { text: "Yaml-file", link: "/docs/providers/ai/yaml-file.md" },
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
                text: "Policy-attachment",
                link: "/docs/providers/aws/policy-attachment.md",
              },
              { text: "Queue", link: "/docs/providers/aws/queue.md" },
              { text: "Role", link: "/docs/providers/aws/role.md" },
              { text: "Ses", link: "/docs/providers/aws/ses.md" },
              { text: "Table", link: "/docs/providers/aws/table.md" },
            ],
          },
          {
            text: "cloudflare",
            collapsed: true,
            items: [
              {
                text: "Account-api-token",
                link: "/docs/providers/cloudflare/account-api-token.md",
              },
              { text: "Dns", link: "/docs/providers/cloudflare/dns.md" },
              {
                text: "Kv-namespace",
                link: "/docs/providers/cloudflare/kv-namespace.md",
              },
              {
                text: "Permission-groups",
                link: "/docs/providers/cloudflare/permission-groups.md",
              },
              { text: "Bucket", link: "/docs/providers/cloudflare/bucket.md" },
              {
                text: "Static-site",
                link: "/docs/providers/cloudflare/static-site.md",
              },
              { text: "Worker", link: "/docs/providers/cloudflare/worker.md" },
              {
                text: "Wrangler.json",
                link: "/docs/providers/cloudflare/wrangler.json.md",
              },
              { text: "Zone", link: "/docs/providers/cloudflare/zone.md" },
            ],
          },
          {
            text: "dns",
            collapsed: true,
            items: [
              { text: "Import-dns", link: "/docs/providers/dns/import-dns.md" },
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
              { text: "Copy-file", link: "/docs/providers/fs/copy-file.md" },
              { text: "File", link: "/docs/providers/fs/file.md" },
              { text: "Folder", link: "/docs/providers/fs/folder.md" },
              {
                text: "Static-astro-file",
                link: "/docs/providers/fs/static-astro-file.md",
              },
              {
                text: "Static-css-file",
                link: "/docs/providers/fs/static-css-file.md",
              },
              {
                text: "Static-html-file",
                link: "/docs/providers/fs/static-html-file.md",
              },
              {
                text: "Static-text-file",
                link: "/docs/providers/fs/static-text-file.md",
              },
              {
                text: "Static-typescript-file",
                link: "/docs/providers/fs/static-typescript-file.md",
              },
              {
                text: "Static-vue-file",
                link: "/docs/providers/fs/static-vue-file.md",
              },
              {
                text: "Static-yaml-file",
                link: "/docs/providers/fs/static-yaml-file.md",
              },
            ],
          },
          {
            text: "github",
            collapsed: true,
            items: [
              { text: "Secret", link: "/docs/providers/github/secret.md" },
            ],
          },
          {
            text: "stripe",
            collapsed: true,
            items: [
              { text: "Price", link: "/docs/providers/stripe/price.md" },
              { text: "Product", link: "/docs/providers/stripe/product.md" },
              { text: "Webhook", link: "/docs/providers/stripe/webhook.md" },
            ],
          },
        ],
      },
    ],
  },
});
