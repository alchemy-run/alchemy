import alchemy from "alchemy";

import "alchemy/cloudflare";
import "alchemy/fs";
import "alchemy/vitepress";

import { StaticSite } from "alchemy/cloudflare";
import { Folder } from "alchemy/fs";
import { CustomTheme, HomePage } from "alchemy/vitepress";
import { GettingStarted } from "./src/getting-started";
import { AlchemyProject } from "./src/project";
import { AlchemyProviderDocs } from "./src/providers";

const app = alchemy("alchemy-web", {
  quiet: !process.argv.includes("--verbose"),
});

const docs = await Folder("docs");

const [theme, home, gettingStarted, providers] = await Promise.all([
  CustomTheme("theme", {
    outDir: ".vitepress/theme",
    title: "Alchemy",
    description: "Agentic Infrastructure as Code 🪄",
    prompt: await alchemy`
      Create a custom theme for the Alchemy documentation site.
      Use pastel colors like #FFB6C1 and #87CEEB.
      Use a modern and clean design.
    `,
    model: {
      id: "claude-3-7-sonnet-latest",
      provider: "anthropic",
    },
  }),
  HomePage("home", {
    outFile: "index.md",
    title: "Alchemy",
    hero: {
      name: "Alchemy",
      text: "Agentic Infrastructure as Code 🪄",
      tagline: "Building the assembly-line for self-generating software",
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
    prompt: await alchemy`
      Using HTML below the frontmatter, create a feature showcase section with:
      
      1. A centered main heading "Features"
      2. A left-to-right alternating layout of 4 features:
        - Resources for Cloud Services (show the Secret, Static Site and Worker example from ${alchemy.file("../README.md")} and ${alchemy.file("../examples/cloudflare-vite/alchemy.run.ts")})
        - Automated development of new Resources using Agentic IDEs (Cursor, Windsurf, etc) (leave example as TODO)
        - Agentic Resources (show a concise example from ${alchemy.files(
          "./src/providers.ts",
          "./src/project.ts",
          "./src/getting-started.ts",
        )})
        - Organizational Tree (show the ${alchemy.file("./alchemy.run.ts")} example)

      Make sure each feature has a code block with syntax highlighting. Use vitepress for syntax highlighting.
      Do not over explain: 1 short sentence per feature is enough.
      Do not use markdown for the feature section.
      # Features <- (not this)
    `,
  }),
  GettingStarted({
    outDir: docs,
  }),
  AlchemyProviderDocs({
    filter: true,
    outDir: docs,
  }),
  // TODO: add other docs
]);

export const project = await AlchemyProject({
  hero: {
    text: "Agentic Infrastructure as Code 🪄",
    // text: "Agentic IaC 🪄",
    // tagline: "IaC for Gen-AI",
    // tagline: "IaC that's as simple as bunx",
    // tagline: "Portable infrastructure, in a language you and LLMs just know",
    tagline: "Agentic Infrastructure-as-Code in pure TypeScript",
  },
  docs: {
    providers,
  },
});

if (process.argv.includes("--deploy")) {
  const site = await StaticSite("alchemy.run site", {
    name: "alchemy",
    dir: ".vitepress/dist",
    domain: "alchemy.run",
    build: {
      command: "bun run docs:build",
    },
  });

  console.log({
    url: site.url,
  });
}

await app.finalize();
