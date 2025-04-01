import fs from "fs/promises";
import path from "path";
import { alchemy } from "../alchemy";
import { Document } from "../docs/document";
import { Folder } from "../fs/folder";
import { VitePressProject } from "../vitepress/vitepress";

export async function alchemyDocs(enabled: {
  docs?: boolean | number;
}) {
  await VitePressProject("docs", {
    name: "alchemy-web",
    title: "Alchemy",
    description: "Alchemy is an TypeScript-native, embeddable IaC library",
    overwrite: true,
    tsconfig: {
      extends: "../tsconfig.base.json",
      references: ["../alchemy/tsconfig.json"],
    },
    devDependencies: {
      alchemy: "workspace:*",
    },
    theme: {
      light: "light-plus",
      dark: "dark-plus",
    },
    home: {
      layout: "home",
      hero: {
        text: "Alchemy",
        tagline: "Alchemy is a TypeScript-native, embeddable IaC library",
        actions: [
          {
            text: "Get Started",
            link: "/docs",
            theme: "brand",
          },
        ],
      },
      features: [
        {
          title: "Easy to use",
          details: "Alchemy is easy to use and understand",
        },
      ],
    },
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
              {
                text: "Custom Resource",
                link: "/docs/guides/custom-resource",
              },
              {
                text: "Developing with LLMs",
                link: "/docs/guides/llms",
              },
            ],
          },
          {
            text: "Core",
            items: [
              { text: "Resource", link: "/docs/core/resource" },
              { text: "Scope", link: "/docs/core/scope" },
              { text: "Phases", link: "/docs/core/phases" },
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
                  { text: "Table", link: "/docs/aws/table" },
                  { text: "Simple Email Service", link: "/docs/aws/ses" },
                ].sort((a, b) => a.text.localeCompare(b.text)),
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
                  { text: "Static Site", link: "/docs/cloudflare/static-site" },
                  {
                    text: "KV Namespace",
                    link: "/docs/cloudflare/kv-namespace",
                  },
                  { text: "Worker", link: "/docs/cloudflare/worker" },
                  { text: "Zone", link: "/docs/cloudflare/zone" },
                ].sort((a, b) => a.text.localeCompare(b.text)),
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
              {
                text: "GitHub",
                link: "/docs/github",
                collapsed: true,
                items: [{ text: "Secret", link: "/docs/github/secret" }],
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
            ].sort((a, b) => a.text.localeCompare(b.text)),
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
        {
          icon: "github",
          link: "https://github.com/sam-goodwin/alchemy",
        },
      ],
    },
  });

  const docs = await Folder(path.join("alchemy-web", "docs"));

  const exclude = ["util", "test"];

  // Get all folders in the alchemy/src directory
  let providers = (
    await fs.readdir(path.resolve("alchemy", "src"), {
      withFileTypes: true,
    })
  )
    .filter((dirent) => dirent.isDirectory() && !exclude.includes(dirent.name))
    .map((dirent) => path.join(dirent.parentPath, dirent.name));

  // For each provider, list all files
  if (enabled.docs === false) {
    return;
  } else if (typeof enabled.docs === "number") {
    providers = providers.slice(0, enabled.docs);
  }
  await Promise.all(
    providers.map(async (provider) => {
      const providerName = path.basename(provider);
      const files = (
        await fs.readdir(path.resolve(provider), {
          withFileTypes: true,
        })
      )
        .filter((dirent) => dirent.isFile())
        .map((dirent) =>
          path.relative(process.cwd(), path.resolve(provider, dirent.name)),
        );

      await Document(`docs/${providerName}`, {
        path: path.join(docs.path, `${providerName}.md`),
        prompt: await alchemy`
            You are a technical writer writing API documentation for an Alchemy IaC provider.
            See ${alchemy.file("./README.md")} to understand the overview of Alchemy.
            See ${alchemy.file("./.cursorrules")} to better understand the structure and convention of an Alchemy Resource.
            Then, write concise, clear, and comprehensive documentation for the ${provider} provider:
            ${alchemy.files(files)}
  
            Each code snippet should use twoslash syntax for proper highlighting.
  
            E.g.
            \`\`\`ts twoslash
            import alchemy from "alchemy";
  
            alchemy
            //  ^?
  
            // it needs to be placed under the symbol like so:
            const foo = "string";
            //     ^?
  
            alchemy.ru
                //  ^|
            \`\`\`
  
            The \`^?\` syntax is for displaying the type of an expression.
            The \`^|\` syntax is for displaying auto-completions after a dot and (optional prefix)
          `,
      });
    }),
  );
}
