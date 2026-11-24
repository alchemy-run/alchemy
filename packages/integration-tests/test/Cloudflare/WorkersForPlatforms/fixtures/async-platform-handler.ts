/// <reference types="@cloudflare/workers-types" />

import { type AsyncPlatformWorkerEnv, outboundValues } from "./shared.ts";

/**
 * Async (non-Effect) platform Worker handler. The dispatch namespace is bound
 * via `env: { DISPATCH }` (see `shared.ts`); `InferEnv` types `env.DISPATCH` as
 * the native `cf.DispatchNamespace`, so `env.DISPATCH.get(name)` returns a
 * `Fetcher` for the user Worker. Mirrors the Effect-native `platform-worker.ts`
 * routes so the test can drive both styles identically.
 *
 * `GET /outbound/:scriptName?tenant=…` dispatches through `DISPATCH_OUTBOUND`,
 * passing the outbound values `outboundValues` reads from the query, and asks
 * the user Worker to fetch the internet (`/egress`). A dispatch that throws
 * answers 500 with the error. `GET /outbound-headers/:scriptName?tenant=…`
 * dispatches the same way with the request's own `Authorization` header, and
 * returns what the user Worker saw. `GET /outbound-marked/:scriptName?tenant=…`
 * dispatches to the user Worker's `/marked` and returns its status, body and
 * the dev shim's two headers as platform code sees them.
 */
export default {
  async fetch(request: Request, env: AsyncPlatformWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const outbound = url.pathname.match(/^\/outbound\/([^/]+)$/);
    if (outbound) {
      try {
        const userWorker = env.DISPATCH_OUTBOUND.get(
          outbound[1]!,
          {},
          {
            outbound: outboundValues(url.searchParams),
          },
        );
        return await userWorker.fetch("https://user-worker/egress");
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }
    const headers = url.pathname.match(/^\/outbound-headers\/([^/]+)$/);
    if (headers) {
      const userWorker = env.DISPATCH_OUTBOUND.get(
        headers[1]!,
        {},
        { outbound: outboundValues(url.searchParams) },
      );
      return userWorker.fetch(
        new Request("https://user-worker/headers", {
          headers: { authorization: request.headers.get("authorization") ?? "" },
        }),
      );
    }
    const marked = url.pathname.match(/^\/outbound-marked\/([^/]+)$/);
    if (marked) {
      try {
        const res = await env.DISPATCH_OUTBOUND.get(
          marked[1]!,
          {},
          { outbound: outboundValues(url.searchParams) },
        ).fetch("https://user-worker/marked");
        return Response.json({
          status: res.status,
          text: await res.text(),
          shim: res.headers.get("x-alchemy-dispatch-shim"),
          error: res.headers.get("x-alchemy-dispatch-error"),
        });
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
