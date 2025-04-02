import { VitePressProject } from "alchemy/vitepress";
import path from "path";
import type { AlchemyProviderDocs } from "./providers";

export interface AlchemyProjectProps {
  hero: {
    text: string;
    tagline: string;
  };
  docs: {
    providers: AlchemyProviderDocs;
  };
}

export type AlchemyProject = VitePressProject;

export function AlchemyProject({
  hero,
  docs,
}: AlchemyProjectProps): Promise<AlchemyProject> {
  return VitePressProject("docs", {
    name: "alchemy-web",
    title: "Alchemy",
    dir: process.cwd(),
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
        text: hero.text,
        tagline: hero.tagline,
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
            items: docs.providers
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
