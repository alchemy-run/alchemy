import { type } from "arktype";
import fs from "fs/promises";
import path from "path";
import { Data, Document } from "../ai";
import { alchemy } from "../alchemy";
import { Folder } from "../fs";

export interface DocsProps {
  /**
   * The output directory for the docs.
   */
  outDir: string | Folder;

  /**
   * The source directory for the docs.
   */
  srcDir: string;

  /**
   * Whether to filter the docs.
   * If true, include all docs.
   * If false, include none.
   * If a number, include that many providers.
   *
   * @default true (all docs)
   */
  filter?: boolean | number;
}

export type AlchemyProviderDocs = {
  dir: string;
  provider: string;
  documents: Document[];
}[];

export async function AlchemyProviderDocs({
  srcDir,
  outDir,
  filter,
}: DocsProps): Promise<AlchemyProviderDocs> {
  outDir = typeof outDir === "string" ? outDir : outDir.path;

  const exclude = [
    "util",
    "test",
    "vitepress",
    "vite",
    "shadcn",
    "internal",
    "web",
  ];

  // Get all folders in the alchemy/src directory
  let providers = (
    await fs.readdir(srcDir, {
      withFileTypes: true,
    })
  )
    .filter((dirent) => dirent.isDirectory() && !exclude.includes(dirent.name))
    .map((dirent) => path.join(dirent.parentPath, dirent.name));

  // For each provider, list all files
  if (filter === false) {
    return [];
  } else if (typeof filter === "number") {
    providers = providers.slice(0, filter);
  }

  return await Promise.all(
    providers.map(async (provider) => {
      const providerName = path.basename(provider);
      const files = (
        await fs.readdir(path.resolve(provider), {
          withFileTypes: true,
        })
      )
        .filter((dirent) => dirent.isFile())
        .map((dirent) =>
          path.relative(process.cwd(), path.resolve(provider, dirent.name))
        )
        .filter((file) => file.endsWith(".ts") && !file.endsWith("index.ts"));

      const {
        object: { groups },
      } = await Data(`docs/${providerName}`, {
        model: {
          id: "o3-mini",
          provider: "openai",
          options: {
            reasoningEffort: "high",
          },
        },
        temperature: 0.1,
        schema: type({
          groups: type({
            title: type("string").describe(
              "The title of the group, should be the Resource Name exactly as it's defined in code (const ResourceName translates to 'Resource Name') without spaces, e.g. Bucket or Static Site."
            ),
            filename: type("string").describe(
              "The filename of the Resource's Document, e.g. bucket.md or static-site.md"
            ),
            category: type("'Resource'|'Client'|'Utility'|'Types'").describe(
              "The classification of the Resource's Document, one of: Resource, Client, Utility, or Types."
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

          The title should be simply the name of the resource's const in code (with spaces added in between each word), e.g. "Bucket" or "Function", except with spaces, e.g. "Static Site" for "const StaticSite". Maintain all other casing.

          // "Resource Name"
          const ResourceName = Resource(...)
        `,
      });

      // console.log(groups);

      const providerDocsDir = (await Folder(path.join(outDir, providerName)))
        .path;

      const documents = await Promise.allSettled(
        groups
          .filter((g) => g.category === "Resource")
          .map(async (g) =>
            Document(`docs/${providerName}/${g.title}`, {
              title: g.title,
              path: path.join(
                providerDocsDir,
                `${g.filename.replace(".ts", "").replace(".md", "")}.md`
              ),
              model: {
                id: "claude-3-5-sonnet-latest",
                provider: "anthropic",
                // options: {
                //   reasoningEffort: "high",
                // },
              },
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

                (brief 1-2 sentences of what it does)

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
            })
          )
      );

      // Unwrap all documents, fail if any rejected
      const results = await Promise.all(
        documents.map((r) => {
          if (r.status === "rejected") {
            throw r.reason;
          }
          return r.value;
        })
      );

      return {
        dir: providerDocsDir,
        provider: providerName,
        documents: results,
      } as const;
    })
  );
}
