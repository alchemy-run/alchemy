/// <reference types="@types/node" />

import alchemy from "alchemy";
import { SvelteKit } from "alchemy/cloudflare";

const app = await alchemy("my-alchemy-app");

export const worker = await SvelteKit("website", {
  command: "bun run build",
});

console.log({
  url: worker.url,
});

await app.finalize();
