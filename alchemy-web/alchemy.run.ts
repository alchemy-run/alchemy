import alchemy from "alchemy";

import "alchemy/cloudflare";
import { StaticSite } from "alchemy/cloudflare";
import "alchemy/fs";
import { Folder } from "alchemy/fs";
import "alchemy/vitepress";
import "./src/project";
import { AlchemyProject } from "./src/project";
import "./src/providers";
import { AlchemyProviderDocs } from "./src/providers";

const app = alchemy("alchemy-web");

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
    text: "Materialize all the Things! 🪄",
    tagline:
      "Generate data and deploy cloud infrastructure with pure async TypeScript.",
  },
  docs: {
    providers,
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
