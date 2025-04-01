import { type } from "arktype";
import fs from "fs/promises";
import path from "path";
import { Data } from "../ai/data";
import { Document } from "../ai/document";
import { alchemy } from "../alchemy";
import { Folder } from "../fs/folder";
import { VitePressProject } from "../vitepress/vitepress";

export interface DocsProps {
  docs?: boolean | number;
}

export type AlchemyDocs = Awaited<ReturnType<typeof AlchemyDocs>>;

export async function AlchemyDocs({ docs: isDocsEnabled }: DocsProps) {
  const root = (await Folder("alchemy-web")).path;

  const docs = (await Folder(path.join(root, "docs"))).path;

  const providersDir = (await Folder(path.join(docs, "providers"))).path;

  const exclude = ["util", "test", "vitepress", "vite", "shadcn", "internal"];

  // Get all folders in the alchemy/src directory
  let providers = (
    await fs.readdir(path.resolve("alchemy", "src"), {
      withFileTypes: true,
    })
  )
    .filter((dirent) => dirent.isDirectory() && !exclude.includes(dirent.name))
    .map((dirent) => path.join(dirent.parentPath, dirent.name));

  // For each provider, list all files
  if (isDocsEnabled === false) {
    return;
  } else if (typeof isDocsEnabled === "number") {
    providers = providers.slice(0, isDocsEnabled);
  }

  const providerDocs = await Promise.all(
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
        )
        .filter((file) => file.endsWith(".ts") && !file.endsWith("index.ts"));

      const {
        object: { groups },
      } = await Data(`docs/${providerName}`, {
        schema: type({
          groups: type({
            title: type("string").describe(
              "The title of the group, should be the Resource Name exactly without spaces, e.g. Bucket or Static Site.",
            ),
            filename: type("string").describe(
              "The filename of the Resource's Document, e.g. bucket.md or static-site.md",
            ),
            category: type("'Resource'|'Client'|'Utility'|'Types'").describe(
              "The classification of the Resource's Document, one of: Resource, Client, Utility, or Types.",
            ),
          }).array(),
        }),
        system: await alchemy`
          You are a technical writer tasked with identifying the distinct documents that need to be written for a document group (folder) in a documentation site.
          You will be provided with a list of documents and instructions on how to classify them.
          Each document has a title, file name, and category.
        `,
        prompt: await alchemy`
          Identify and classify the documents that need to be written for the '${provider}' Service's Alchemy Resources.
          For background knowledge on Alchemy, see ${alchemy.file("./README.md")}.
          For background knowledge on the structure of an Alchemy Resource, see ${alchemy.file("./.cursorrules")}.

          The ${provider} Service has the following resources:
          ${alchemy.files(files)}

          A file is considered a "Resource" if it contains a const <ResourceName> = Resource(...) call or if it is a function that calls a Resource function, e.g. const TypeScriptFile = () => File(...).
          A file is considered a "Client" if it exposes a wrapper around creating a SDK client or fetch.
          A file is considered a "Utility" if it contains utility functions that are not resources or clients.
          A file is considered a "Types" if it contains just type definitions and maybe helpers around working with those types.

          The title should be simply the name of the resource, e.g. "Bucket" or "Function", except with spaces, e.g. "Static Site" instead of "StaticSite". Maintain all other casing.
        `,
      });

      const providerDocsDir = (
        await Folder(path.join(providersDir, providerName))
      ).path;

      const documents = await Promise.all(
        groups
          .filter((g) => g.category === "Resource")
          .map(async (g) =>
            Document(`docs/${providerName}/${g.title}`, {
              title: g.title,
              path: path.join(
                providerDocsDir,
                `${g.filename.replace(".ts", "").replace(".md", "")}.md`,
              ),
              prompt: await alchemy`
                You are a technical writer writing API documentation for an Alchemy IaC Resource.
                See ${alchemy.file("./README.md")} to understand the overview of Alchemy.
                See ${alchemy.file("./.cursorrules")} to better understand the structure and convention of an Alchemy Resource.

                Relevant files for the ${providerName} Service:
                ${alchemy.files(files)}
                
                Write concise documentation for the "${g.title}" Resource.

                > [!CAUTION]
                > Avoid the temptation to over explain or over describe. Focus on concise, simple, high value snippets. One heading and 0-1 descriptions per snippet.
                
                > [!TIP]
                > Make sure the examples follow a natural progression from the minimal example to logical next steps of how the Resource might be used.

                Each document must follow the following format:
                
                # ${g.title}

                (simple description with an external link to the provider's website)
                e.g.
                The Efs component lets you add [Amazon Elastic File System (EFS)](https://docs.aws.amazon.com/efs/latest/ug/whatisefs.html) to your app.

                # Minimal Example

                \`\`\`ts
                import { ${g.title.replaceAll(" ", "")} } from "alchemy/${providerName}";

                (example)
                \`\`\`


                # Create the ${g.title}

                \`\`\`ts
                import { ${g.title.replaceAll(" ", "")} } from "alchemy/${providerName}";

                (example)
                \`\`\`

                ${
                  providerName === "cloudflare"
                    ? await alchemy`# Bind to a Worker
                (if it is a Cloudflare Resource)

                \`\`\`ts
                import { Worker, ${g.title.replaceAll(" ", "")} } from "alchemy/${providerName}";

                const myResource = await ${g.title.replaceAll(" ", "")}("my-resource", {
                  // ...
                });

                await Worker("my-worker", {
                  name: "my-worker",
                  script: "console.log('Hello, world!')",
                  bindings: {
                    myResource,
                  },
                });
                \`\`\``
                    : ""
                }
              `,
            }),
          ),
      );

      return {
        dir: providerDocsDir,
        provider: providerName,
        documents,
      } as const;
    }),
  );

  await VitePressProject("docs", {
    name: "alchemy-web",
    title: "Alchemy",
    description: "Alchemy is an TypeScript-native, embeddable IaC library",
    overwrite: true,
    delete: false,
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
        name: "Alchemy",
        text: "Materialize all the things! 🪄",
        tagline: "TypeScript-native Infrastructure-as-Code (IaC)",
        image: {
          src: "./public/alchemist.png",
          alt: "The Alchemist",
        },
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
          title: "JS-native",
          details:
            "No second language, toolchains, dependencies, processes, services, etc. to lug around.",
        },
        {
          title: "Async",
          details:
            "Resources are just async functions - no complex abstraction to learn.",
        },
        {
          title: "ESM",
          details:
            "Built exclusively on ESM, with a slight preference for modern JS runtimes like Bun.",
        },
        {
          title: "Embeddable",
          details:
            "Runs in any JavaScript/TypeScript environment, including the browser!",
        },
        {
          title: "Extensible",
          details: "Implement your own resources with a simple function.",
        },
        {
          title: "AI-first",
          details:
            "Create, copy, fork, and modify resources using LLMs to fit your needs.",
        },
        {
          title: "No dependencies",
          details: "The alchemy core package has 0 required dependencies.",
        },
        {
          title: "No service",
          details:
            "State files are stored locally in your project for easy inspection and version control.",
        },
        {
          title: "No strong opinions",
          details:
            "Structure your codebase however you want, store state anywhere - we don't care!",
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
                text: "Automating with LLMs",
                link: "/docs/guides/llms",
              },
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
            items: providerDocs
              .map((provider) => ({
                text: provider.provider,
                link: `/docs/providers/${provider.provider}`,
                collapsed: true,
                items: provider.documents.map((document) => ({
                  text: document.title,
                  link: `/docs/providers/${provider.provider}/${path.basename(document.path, ".md")}`,
                })),
              }))
              .sort((a, b) => a.text.localeCompare(b.text)),
          },
        ],
        "/examples/": [
          {
            text: "Examples",
            items: [{ text: "Foo", link: "/examples/foo" }],
          },
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
}
