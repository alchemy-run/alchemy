// Sourced from: https://posthog.com/docs/advanced/proxy/cloudflare
// We have modified it to use typescript and some alchemy goodies

import type { posthogProxy } from "../alchemy.run.ts";

type Env = (typeof posthogProxy)["Env"];

async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const search = url.search;
  const pathWithParams = pathname + search;

  if (pathname.startsWith("/static/")) {
    return retrieveStatic(request, pathWithParams, env, ctx);
  } else {
    return forwardRequest(request, pathWithParams, env);
  }
}

async function retrieveStatic(
  request: Request,
  pathname: string,
  env: Env,
  ctx: ExecutionContext,
) {
  const assetCache = await caches.open("asset-cache");
  let response = await assetCache.match(request);
  if (!response) {
    response = await fetch(
      `https://${env.POSTHOT_ASSET_DESTINATION_HOST}${pathname}`,
    );
    ctx.waitUntil(assetCache.put(request, response.clone()));
  }
  return response;
}

async function forwardRequest(
  request: Request,
  pathWithSearch: string,
  env: Env,
) {
  const originRequest = new Request(request);
  originRequest.headers.delete("cookie");
  return await fetch(
    `https://${env.POSTHOG_DESTINATION_HOST}${pathWithSearch}`,
    originRequest,
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handleRequest(request, env, ctx);
  },
} as ExportedHandler<Env>;
