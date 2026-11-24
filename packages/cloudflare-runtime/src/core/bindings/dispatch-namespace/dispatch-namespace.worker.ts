interface Env {
  proxyClient: Fetcher;
}

export default function makeBinding(env: Env): DispatchNamespace {
  return {
    get(
      name: string,
      args?: { [key: string]: unknown },
      options?: DynamicDispatchOptions,
    ): Fetcher {
      const metadata = JSON.stringify({ name, args, options });
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = new Request(input, init);
          const headers = new Headers(request.headers);
          headers.set("MF-Dispatch-Namespace-Options", metadata);
          const response = await env.proxyClient.fetch(new Request(request, { headers }));
          // A dispatch that failed on the deployed shim (an unknown script, a
          // missing outbound value) rejects here, as it does on Cloudflare.
          if (response.headers.has("x-alchemy-dispatch-error")) {
            throw new Error(await response.text());
          }
          return response;
        },
        connect() {
          throw new Error("DispatchNamespace.get().connect() is not supported");
        },
      } as Fetcher;
    },
  } satisfies DispatchNamespace;
}
