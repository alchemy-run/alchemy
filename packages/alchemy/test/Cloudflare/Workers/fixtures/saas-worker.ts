/// <reference types="@cloudflare/workers-types" />

// Minimal worker fixture used by WorkerDomainDns.test.ts: answers every
// request on its Cloudflare for SaaS custom hostname.
export default {
  fetch: async () => new Response("saas-ok"),
};
