import { transformerTwoslash } from "@shikijs/vitepress-twoslash";
import footnotePlugin from "markdown-it-footnote";
import { defineConfig } from "vitepress";

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "Alchemy",
  description: "Alchemy Docs",
  head: [
    ["link", { rel: "icon", type: "image/png", href: "/alchemy-flower.png" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "Alchemy" }],
    ["meta", { property: "og:description", content: "Alchemy Docs" }],
    ["meta", { property: "og:url", content: "https://alchemy.run" }],
    [
      "meta",
      {
        property: "og:image",
        content: "https://alchemy.run/alchemy-unfurl.png",
      },
    ],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: "Alchemy" }],
    ["meta", { name: "twitter:description", content: "Alchemy Docs" }],
    [
      "meta",
      {
        name: "twitter:image",
        content: "https://alchemy.run/alchemy-unfurl.png",
      },
    ],
  ],
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
          {
            text: "Use AI to develop Custom Resources",
            link: "/docs/guides/custom-resources.md",
          },
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
                text: "Durable Objects & Migrations",
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
              { text: "AstroFile", link: "/docs/providers/ai/astro-file" },
              { text: "CSSFile", link: "/docs/providers/ai/css-file" },
              { text: "Data", link: "/docs/providers/ai/data" },
              { text: "Document", link: "/docs/providers/ai/document" },
              { text: "HTMLFile", link: "/docs/providers/ai/html-file" },
              { text: "JSONFile", link: "/docs/providers/ai/json-file" },
              {
                text: "TypeScriptFile",
                link: "/docs/providers/ai/typescript-file",
              },
              { text: "VueFile", link: "/docs/providers/ai/vue-file" },
              { text: "YAMLFile", link: "/docs/providers/ai/yaml-file" },
            ],
          },
          {
            text: "aws",
            collapsed: true,
            items: [
              { text: "Bucket", link: "/docs/providers/aws/bucket" },
              { text: "Function", link: "/docs/providers/aws/function" },
              { text: "Policy", link: "/docs/providers/aws/policy" },
              {
                text: "PolicyAttachment",
                link: "/docs/providers/aws/policy-attachment",
              },
              { text: "Queue", link: "/docs/providers/aws/queue" },
              { text: "Role", link: "/docs/providers/aws/role" },
              { text: "SES", link: "/docs/providers/aws/ses" },
              { text: "Table", link: "/docs/providers/aws/table" },
            ],
          },
          {
            text: "cloudflare",
            collapsed: true,
            items: [
              {
                text: "AccountApiToken",
                link: "/docs/providers/cloudflare/account-api-token",
              },
              {
                text: "AccountId",
                link: "/docs/providers/cloudflare/account-id",
              },
              {
                text: "CustomDomain",
                link: "/docs/providers/cloudflare/custom-domain",
              },
              {
                text: "DnsRecords",
                link: "/docs/providers/cloudflare/dns-records",
              },
              {
                text: "KVNamespace",
                link: "/docs/providers/cloudflare/kv-namespace",
              },
              {
                text: "PermissionGroups",
                link: "/docs/providers/cloudflare/permission-groups",
              },
              { text: "R2Bucket", link: "/docs/providers/cloudflare/bucket" },
              {
                text: "StaticSite",
                link: "/docs/providers/cloudflare/static-site",
              },
              { text: "Worker", link: "/docs/providers/cloudflare/worker" },
              {
                text: "WranglerJson",
                link: "/docs/providers/cloudflare/wrangler.json",
              },
              { text: "Zone", link: "/docs/providers/cloudflare/zone" },
            ],
          },
          {
            text: "dns",
            collapsed: true,
            items: [
              {
                text: "ImportDnsRecords",
                link: "/docs/providers/dns/import-dns",
              },
            ],
          },
          {
            text: "esbuild",
            collapsed: true,
            items: [{ text: "Bundle", link: "/docs/providers/esbuild/bundle" }],
          },
          {
            text: "fs",
            collapsed: true,
            items: [
              { text: "CopyFile", link: "/docs/providers/fs/copy-file" },
              { text: "File", link: "/docs/providers/fs/file" },
              { text: "Folder", link: "/docs/providers/fs/folder" },
              {
                text: "StaticAstroFile",
                link: "/docs/providers/fs/static-astro-file",
              },
              {
                text: "StaticCSSFile",
                link: "/docs/providers/fs/static-css-file",
              },
              {
                text: "StaticHTMLFile",
                link: "/docs/providers/fs/static-html-file",
              },
              {
                text: "StaticJsonFile",
                link: "/docs/providers/fs/static-json-file",
              },
              {
                text: "StaticTextFile",
                link: "/docs/providers/fs/static-text-file",
              },
              {
                text: "StaticTypeScriptFile",
                link: "/docs/providers/fs/static-typescript-file",
              },
              {
                text: "StaticVueFile",
                link: "/docs/providers/fs/static-vue-file",
              },
              {
                text: "StaticYamlFile",
                link: "/docs/providers/fs/static-yaml-file",
              },
            ],
          },
          {
            text: "github",
            collapsed: true,
            items: [
              { text: "GitHubSecret", link: "/docs/providers/github/secret" },
            ],
          },
          {
            text: "stripe",
            collapsed: true,
            items: [
              { text: "Price", link: "/docs/providers/stripe/price" },
              { text: "Product", link: "/docs/providers/stripe/product" },
              {
                text: "WebhookEndpoint",
                link: "/docs/providers/stripe/webhook",
              },
            ],
          },
        ],
      },
    ],
    search: { provider: "local" },
  },
});
