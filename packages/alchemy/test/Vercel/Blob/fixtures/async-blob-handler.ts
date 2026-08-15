/**
 * Async-mode (no Effect runtime) Vercel Function handler using the
 * promise-based `readWriteBlobFromEnv` client against a PRIVATE store —
 * the platform-injected `BLOB_READ_WRITE_TOKEN` is the only credential.
 */
import { readWriteBlobFromEnv } from "@/Vercel/Blob/BlobFromEnv.ts";

const uploads = readWriteBlobFromEnv({ access: "private" });

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.searchParams.get("path") ?? "";
    const body = url.searchParams.get("body") ?? "";
    try {
      if (url.pathname === "/put") {
        const put = await uploads.put(path, body, {
          contentType: "text/plain",
        });
        return Response.json({ etag: put.etag, url: put.url });
      }
      if (url.pathname === "/get") {
        const blob = await uploads.get(path);
        return Response.json({ text: blob.text });
      }
      if (url.pathname === "/list") {
        const listed = await uploads.list({
          prefix: url.searchParams.get("prefix") ?? undefined,
        });
        return Response.json({
          pathnames: listed.blobs.map((row) => row.pathname).sort(),
        });
      }
      if (url.pathname === "/del") {
        await uploads.del(path);
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
