/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Nuxt } from "alchemy/cloudflare";
import { backend } from "backend/alchemy";

const app = await alchemy("nuxt-frontend");

export const worker = await Nuxt("website", {
  bindings: {
    backend,
  },
});

console.log({
  url: worker.url,
});

await app.finalize();
