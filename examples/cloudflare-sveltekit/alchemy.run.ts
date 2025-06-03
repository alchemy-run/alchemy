/// <reference types="node" />

import alchemy from "alchemy";
import {
  KVNamespace,
  R2Bucket,
  R2RestStateStore,
  SvelteKit,
} from "alchemy/cloudflare";

const BRANCH_PREFIX = process.env.BRANCH_PREFIX ?? "";
const app = await alchemy("cloudflare-sveltekit", {
  stage: process.env.USER ?? "dev",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  quiet: !process.argv.includes("--verbose"),
  password: process.env.ALCHEMY_PASSWORD,
  stateStore:
    process.env.ALCHEMY_STATE_STORE === "cloudflare"
      ? (scope) => new R2RestStateStore(scope)
      : undefined,
});

export const [authStore, storage] = await Promise.all([
  KVNamespace("AUTH_STORE", {
    title: `cloudflare-sveltekit-auth-store${BRANCH_PREFIX}`,
    adopt: true,
  }),
  R2Bucket(`cloudflare-sveltekit-storage${BRANCH_PREFIX}`, {
    allowPublicAccess: false,
    // so that CI is idempotent
    adopt: true,
  }),
]);

export const website = await SvelteKit(`cloudflare-sveltekit-website${BRANCH_PREFIX}`, {
  bindings: {
    STORAGE: storage,
    AUTH_STORE: authStore,
  },
});

console.log({
  url: website.url,
});

await app.finalize(); 