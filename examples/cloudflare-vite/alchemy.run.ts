/// <reference types="node" />

import alchemy from "alchemy";
import { KVNamespace, R2Bucket, Vite } from "alchemy/cloudflare";

const app = await alchemy("cloudflare-vite");

export const [authStore, storage] = await Promise.all([
  KVNamespace("auth-store", {
    title: `${app.name}-${app.stage}-auth-store`,
    adopt: true,
  }),
  R2Bucket("storage", {
    name: `${app.name}-${app.stage}-storage`,
    allowPublicAccess: false,
    // so that CI is idempotent
    adopt: true,
  }),
]);

export const website = await Vite("website", {
  name: `${app.name}-${app.stage}-website`,
  main: "./src/index.ts",
  bindings: {
    STORAGE: storage,
    AUTH_STORE: authStore,
  },
});

console.log({
  url: website.url,
});

await app.finalize();
