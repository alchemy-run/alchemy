/// <reference types="@cloudflare/workers-types" />

type Env = { TARGET: Fetcher };

/**
 * Calls the `TARGET` Worker over a service binding and prefixes what it
 * answers, to prove the call crossed the binding rather than a public URL.
 */
export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const response = await env.TARGET.fetch("https://target/via-binding");
    return new Response(`caller saw: ${await response.text()}`, { status: response.status });
  },
};
