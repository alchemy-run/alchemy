import type { SecretsStoreSecret } from "@cloudflare/workers-types";

export default {
  async fetch(_request: Request, env: { SECRET: SecretsStoreSecret }) {
    return new Response(await env.SECRET.get());
  },
};
