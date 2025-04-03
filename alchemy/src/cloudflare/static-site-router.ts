import { Hono } from "hono";

// see: https://developers.cloudflare.com/workers/runtime-apis/cache/
declare var caches: {
  default: Cache;
};

// injected by src/cloudflare/static-site.ts
declare var __ASSET_MANIFEST__: Record<string, string>;

export type Env = {
  ASSETS: KVNamespace;
  INDEX_PAGE: string;
  ERROR_PAGE?: string;
  /**
   * Optional backend worker bound to this static site
   * Used to handle requests that don't match any static files
   */
  BACKEND_WORKER?: Service;
} & {
  // the binding to route the fetch call to
  [key in `ROUTE_${string}`]: Service;
} & {
  // the route to match on, e.g. /api/*
  [key in `__ROUTE_${string}`]: string;
};

let isInit = false;
const app = new Hono<{ Bindings: Env }>();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isInit) {
      isInit = true;
      for (const [key, value] of Object.entries(env)) {
        if (key.startsWith("ROUTE_")) {
          const service = value as Service;
          const patternKey = `__${key}`;
          if (!(patternKey in env)) {
            throw new Error(`Missing pattern key: ${patternKey}`);
          }
          const pattern = (env as any)[`__${key}`];
          // TODO(sam): we should support narrowing down METHOD
          app.all(pattern, (ctx) => service.fetch(ctx.req.raw));
        }
      }
    }
    return app.fetch(request, env);
  },
};

// fall back to assuming the request is a static file
app.notFound(async (ctx) => {
  const request = ctx.req;
  const env = ctx.env;
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/^\//, "");
  const filePath = pathname === "" ? env.INDEX_PAGE : pathname;

  // Return from cache if available
  const cachedResponse = await lookupCache();
  if (cachedResponse) {
    return cachedResponse;
  }

  // Fetch from KV
  {
    const object = await env.ASSETS.getWithMetadata(filePath, {
      type: "arrayBuffer",
    });
    if (object.value) {
      return await respond(200, filePath, object);
    }
  }
  {
    const guess = filePath + (filePath.endsWith("/") ? "" : "/") + "index.html";
    const object = await env.ASSETS.getWithMetadata(guess, {
      type: "arrayBuffer",
    });
    if (object.value) {
      return await respond(200, guess, object);
    }
  }
  {
    const guess = filePath + ".html";
    const object = await env.ASSETS.getWithMetadata(guess, {
      type: "arrayBuffer",
    });
    if (object.value) {
      return await respond(200, guess, object);
    }
  }

  // Handle error page
  if (env.ERROR_PAGE) {
    const object = await env.ASSETS.getWithMetadata(env.ERROR_PAGE, {
      type: "arrayBuffer",
    });
    if (object.value) {
      return await respond(404, env.ERROR_PAGE, object);
    }
  } else {
    const object = await env.ASSETS.getWithMetadata(env.INDEX_PAGE, {
      type: "arrayBuffer",
    });
    if (object.value) {
      return await respond(200, env.INDEX_PAGE, object);
    }
  }

  return new Response("Page Not Found", { status: 404 });

  async function lookupCache() {
    const cache = caches.default;
    const r = await cache.match(request.url);

    // cache does not exist
    if (!r) return;

    // cache exists but etag does not match
    if (r.headers.get("etag") !== __ASSET_MANIFEST__[filePath]) return;

    // cache exists
    return r;
  }

  async function saveCache(response: Response) {
    const cache = caches.default;
    await cache.put(request.url, response.clone());
  }

  async function respond(
    status: number,
    filePath: string,
    object: KVNamespaceGetWithMetadataResult<any, any>
  ) {
    // build response
    const headers = new Headers();
    if (__ASSET_MANIFEST__[filePath]) {
      headers.set("etag", __ASSET_MANIFEST__[filePath]);
      headers.set("content-type", object.metadata.contentType);
      headers.set("cache-control", object.metadata.cacheControl);
    }

    // Create response with the raw data directly
    const response = new Response(object.value, {
      status,
      headers,
    });

    if (request.method === "GET") {
      await saveCache(response);
    }

    return response;
  }
});
