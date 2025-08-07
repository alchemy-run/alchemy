import alchemy from "alchemy";
import { KVNamespace, R2Bucket, SvelteKit } from "alchemy/cloudflare";

const app = await alchemy("cloudflare-sveltekit");

const [authStore, storage] = await Promise.all([
  KVNamespace("auth-store", {
    title: `${app.name}-${app.stage}-auth-store`,
    adopt: true,
  }),
  R2Bucket("storage", {
    allowPublicAccess: false,
    adopt: true,
    name: `${app.name}-${app.stage}-storage`,
  }),
]);

export const website = await SvelteKit("website", {
  name: `${app.name}-${app.stage}-website`,
  bindings: {
    AUTH_STORE: authStore,
    STORAGE: storage,
    ALCHEMY_TEST_VALUE: alchemy.secret("Hello from Alchemy!"),
  },
  url: true,
});

console.log(website.url);

if (process.env.ALCHEMY_E2E) {
  const { test } = await import("./test/e2e.js");
  await test({
    url: website.url,
    env: { ALCHEMY_TEST_VALUE: "Hello from Alchemy!" },
  });
}

await app.finalize();
