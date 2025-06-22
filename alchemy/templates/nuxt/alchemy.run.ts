/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Nuxt } from "alchemy/cloudflare";

const app = await alchemy("my-alchemy-app");

export const worker = await Nuxt("website", {
  command: "bun run build",
});

console.log({
  url: worker.url,
});

await app.finalize();
