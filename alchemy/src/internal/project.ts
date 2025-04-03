import path from "path";
import { VitePressProject } from "../web/vitepress";
import type { AlchemyProviderDocs } from "./providers";

export interface AlchemyProjectProps {
  hero: {
    text: string;
    tagline: string;
  };
  docs: {
    providers?: AlchemyProviderDocs;
  };
}

export type AlchemyProject = VitePressProject;

export function AlchemyProject({
  hero,
  docs,
}: AlchemyProjectProps): Promise<AlchemyProject> {
  return VitePressProject("project", {
    name: "alchemy-web",
    title: "Alchemy",
    dir: process.cwd(),
    description: "Alchemy is an TypeScript-native, embeddable IaC library",
    overwrite: true,
    delete: false,
    scripts: {
      deploy: "bun --env-file ../.env alchemy.run.ts",
    },
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
            items: (docs.providers ?? [])
              .map((provider) => ({
                text: provider.provider,
                // link: `/docs/providers/${provider.provider}`,
                collapsed: true,
                items: provider.documents
                  .map((document) => ({
                    text: document.title,
                    link: `/docs/providers/${provider.provider}/${path.basename(document.path, ".md")}`,
                  }))
                  .sort((a, b) => a.text.localeCompare(b.text)),
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
