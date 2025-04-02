import alchemy from "alchemy";

import "alchemy/cloudflare";
import "alchemy/fs";
import "alchemy/vitepress";
import "./src/project";
import "./src/providers";

import { StaticSite } from "alchemy/cloudflare";
import { Folder } from "alchemy/fs";
import { AlchemyProject } from "./src/project";
import { AlchemyProviderDocs } from "./src/providers";

const app = alchemy("alchemy-web", {
  quiet: true,
});

const docs = await Folder("docs");

const [providers] = await Promise.all([
  await AlchemyProviderDocs({
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
    // providers,
  },
});

export const site = await StaticSite("alchemy.run site", {
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

await app.finalize();
