/**
 * Async-mode Vercel Function fixture for the dev-mixed chain: drives a
 * blob store through the promise `readWriteBlobFromEnv` client so the SAME
 * handler file serves every provider mode in the chain —
 *
 * - LOCAL fn + LIVE store, no token → `/blob/*` reports `tokenMissing`
 *   (pins the documented mixed-stack contract: a live store's token only
 *   materializes as project env of a CONNECTED real project, and a `dev:`
 *   project can never be connected).
 * - LOCAL fn + LIVE store + explicitly injected `BLOB_READ_WRITE_TOKEN`
 *   env → the local process round-trips against the REAL data plane.
 * - LIVE fn (mode-flipped) → the platform-injected token from the
 *   store↔project connection takes over, same routes.
 */
import { readWriteBlobFromEnv } from "@/Vercel/Blob/BlobFromEnv.ts";

const uploads = readWriteBlobFromEnv({ access: "public" });

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.searchParams.get("path") ?? "";
    const body = url.searchParams.get("body") ?? "";
    try {
      if (url.pathname === "/env") {
        return Response.json({
          greeting: process.env.GREETING ?? null,
          vercelEnv: process.env.VERCEL_ENV ?? null,
          deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
          storeId: process.env.BLOB_STORE_ID ?? null,
          hasToken: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
        });
      }
      if (url.pathname === "/blob/put") {
        const put = await uploads.put(path, body, {
          contentType: "text/plain",
        });
        return Response.json({
          etag: put.etag,
          url: put.url,
          pathname: put.pathname,
        });
      }
      if (url.pathname === "/blob/get") {
        const blob = await uploads.get(path);
        return Response.json({ text: blob.text });
      }
      if (url.pathname === "/blob/list") {
        const listed = await uploads.list({
          prefix: url.searchParams.get("prefix") ?? undefined,
        });
        return Response.json({
          pathnames: listed.blobs.map((row) => row.pathname).sort(),
        });
      }
      if (url.pathname === "/blob/del") {
        await uploads.del(path);
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    } catch (error) {
      const message = String(error);
      if (message.includes("BLOB_READ_WRITE_TOKEN")) {
        // The documented missing-token guidance from the env client.
        return Response.json({ tokenMissing: true });
      }
      return Response.json({ error: message }, { status: 500 });
    }
  },
};
