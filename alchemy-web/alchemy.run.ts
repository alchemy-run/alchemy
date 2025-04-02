import alchemy from "alchemy";
import { StaticSite } from "alchemy/cloudflare";
import { Folder } from "alchemy/fs";
import { AlchemyProviderDocs } from "./src";
import { AlchemyProject } from "./src/project";

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
  docs: {
    providers,
  },
});

export const site = await StaticSite("alchemy.run site", {
  name: "alchemy",
  dir: ".vitepress/dist",
  domain: "alchemy.run",
  build: {
    command: "bun run --filter docs:build",
  },
});

console.log({
  url: site.url,
});

await app.finalize();
