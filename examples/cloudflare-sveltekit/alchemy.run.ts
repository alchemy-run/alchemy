import alchemy from "alchemy";
import { KVNamespace, R2Bucket, SvelteKit } from "alchemy/cloudflare";

const app = await alchemy("cloudflare-sveltekit");

export const website = await SvelteKit("website", {
  name: `${app.name}-${app.stage}-website`,
  bindings: {
    AUTH_STORE: await KVNamespace("AUTH_STORE", {
      title: `${app.name}-${app.stage}-auth-store`,
      adopt: true,
    }),
    STORAGE: await R2Bucket("storage", {
      allowPublicAccess: false,
      adopt: true,
      name: `${app.name}-${app.stage}-storage`,
    }),
  },
  url: true,
});

console.log(website.url);

await app.finalize();
