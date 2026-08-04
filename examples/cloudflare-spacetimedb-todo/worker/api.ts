/**
 * Cloudflare Worker companion for the todo SPA.
 *
 * - PUT /upload  — store a file in R2, return { key }
 * - GET  /health — liveness
 *
 * After upload the browser (or this Worker) calls the SpacetimeDB
 * `set_attachment` / `add_todo` reducer with the returned key so the
 * metadata stays in the database (external file-storage pattern).
 *
 * @see https://spacetimedb.com/docs/tables/file-storage
 */
import type { WorkerEnv } from "../alchemy.run.ts";
// WorkerEnv is inferred from the Api Worker env in alchemy.run.ts.

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        database: env.SPACETIMEDB_DATABASE_NAME,
        uri: env.SPACETIMEDB_URI,
      });
    }

    if (request.method === "PUT" && url.pathname === "/upload") {
      const filename =
        url.searchParams.get("filename") ?? `upload-${Date.now()}`;
      const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 128);
      const key = `todos/${Date.now().toString(36)}-${safe}`;
      const body = await request.arrayBuffer();
      await env.MEDIA.put(key, body, {
        httpMetadata: {
          contentType:
            request.headers.get("content-type") ?? "application/octet-stream",
        },
      });
      return Response.json({ key });
    }

    if (request.method === "GET" && url.pathname.startsWith("/file/")) {
      const key = decodeURIComponent(url.pathname.slice("/file/".length));
      const obj = await env.MEDIA.get(key);
      if (!obj) return new Response("Not found", { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      return new Response(obj.body, { headers });
    }

    return new Response("Not found", { status: 404 });
  },
};
