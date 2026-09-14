/// <reference types="@cloudflare/workers-types" />
export default {
  async fetch(request: Request, env: { BUCKET: R2Bucket; REVISION: string }) {
    const url = new URL(request.url);
    if (url.pathname === "/revision") return new Response(env.REVISION);
    if (url.pathname === "/seed") {
      const defaultTier = await env.BUCKET.put("expire/a", "expired");
      await env.BUCKET.put("archive/a", "archive", {
        storageClass: "Standard",
      });
      await env.BUCKET.put("protected/a", "retained", {
        storageClass: "Standard",
      });
      await env.BUCKET.put("keep/a", "kept", { storageClass: "Standard" });
      const incomplete = await env.BUCKET.createMultipartUpload("abort/a", {
        storageClass: "InfrequentAccess",
      });
      const complete = await env.BUCKET.createMultipartUpload("multipart/a", {
        storageClass: "InfrequentAccess",
      });
      const part = await complete.uploadPart(1, "part");
      const multipart = await complete.complete([part]);
      return Response.json({
        uploadId: incomplete.uploadId,
        defaultTier: defaultTier?.storageClass,
        multipartTier: multipart.storageClass,
      });
    }
    if (url.pathname === "/part") {
      try {
        await env.BUCKET.resumeMultipartUpload(
          "abort/a",
          url.searchParams.get("id")!,
        ).uploadPart(1, "too late");
        return Response.json({ accepted: true });
      } catch (error) {
        return Response.json({ accepted: false, error: String(error) });
      }
    }
    if (url.pathname === "/put")
      return Response.json(await env.BUCKET.put("expire/new", "new"));
    return Response.json({
      expired: await env.BUCKET.head("expire/a"),
      archived: await env.BUCKET.head("archive/a"),
      retained: await env.BUCKET.head("protected/a"),
      kept: await env.BUCKET.head("keep/a"),
      objects: (await env.BUCKET.list()).objects,
    });
  },
};
