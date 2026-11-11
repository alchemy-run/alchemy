/// <reference types="@cloudflare/workers-types" />

type Env = Record<string, DurableObjectNamespace | Fetcher | undefined>;

/** GET /?cls=First|Second → that class, hosted by B, answers its own name. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cls = new URL(request.url).searchParams.get("cls") ?? "First";
    const namespace = env[cls] as DurableObjectNamespace | undefined;
    if (namespace === undefined) return new Response(`unbound ${cls}`, { status: 404 });
    return namespace.getByName("x").fetch(request);
  },
};
