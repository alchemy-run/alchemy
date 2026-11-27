/// <reference types="@cloudflare/workers-types" />

import { type AsyncPlatformWorkerEnv, outboundValues } from "./shared.ts";

/**
 * Async (non-Effect) platform Worker handler. The dispatch namespace is bound
 * via `env: { DISPATCH }` (see `shared.ts`); `InferEnv` types `env.DISPATCH` as
 * the native `cf.DispatchNamespace`, so `env.DISPATCH.get(name)` returns a
 * `Fetcher` for the user Worker. Mirrors the Effect-native `platform-worker.ts`
 * routes so the test can drive both styles identically.
 */
export default {
  async fetch(request: Request, env: AsyncPlatformWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    // `GET /outbound/:scriptName?tenant=…` dispatches through the binding
    // with an outbound Worker and asks the user Worker to fetch the internet.
    // A dispatch that throws answers 500 with the error.
    const outbound = url.pathname.match(/^\/outbound\/([^/]+)$/);
    if (outbound) {
      try {
        return await env.DISPATCH_OUTBOUND.get(
          outbound[1]!,
          {},
          { outbound: outboundValues(url.searchParams) },
        ).fetch("https://user-worker/egress");
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }
    const match = url.pathname.match(/^\/dispatch\/([^/]+)(\/.*)?$/);
    if (!match) {
      return new Response("async-platform-worker ok");
    }
    const [, scriptName, rest] = match;
    const userWorker = env.DISPATCH.get(scriptName);
    return userWorker.fetch(
      new Request(`https://user-worker${rest ?? "/"}`, {
        headers: { "x-custom": request.headers.get("x-custom") ?? "" },
      }),
    );
  },
};
