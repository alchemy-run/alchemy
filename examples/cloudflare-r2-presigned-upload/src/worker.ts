/**
 * Presign + proxy Worker. Hands out SigV4 query-string URLs so the
 * browser can PUT/GET R2 objects directly — no Worker round-trip on
 * the data path, no R2 access keys in the browser bundle.
 *
 * The `R2_PRESIGN_*` env bindings are registered automatically by
 * `Cloudflare.R2.PresignedUrlBinding` at deploy time:
 *
 *   R2_PRESIGN_ACCESS_KEY_ID       (plain_text)
 *   R2_PRESIGN_SECRET_ACCESS_KEY   (secret_text)
 *   R2_PRESIGN_ACCOUNT_ID          (plain_text)
 *   R2_PRESIGN_BUCKET_NAME         (plain_text)
 */

interface Env {
  MEDIA: R2Bucket;
  R2_PRESIGN_ACCESS_KEY_ID: string;
  R2_PRESIGN_SECRET_ACCESS_KEY: { get(): Promise<string> };
  R2_PRESIGN_ACCOUNT_ID: string;
  R2_PRESIGN_BUCKET_NAME: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const [accessKeyId, secretAccessKey, accountId, bucketName] =
      await Promise.all([
        Promise.resolve(env.R2_PRESIGN_ACCESS_KEY_ID),
        env.R2_PRESIGN_SECRET_ACCESS_KEY.get(),
        Promise.resolve(env.R2_PRESIGN_ACCOUNT_ID),
        Promise.resolve(env.R2_PRESIGN_BUCKET_NAME),
      ]);

    const { AwsV4Signer } = await import("aws4fetch");
    const host = `${accountId}.r2.cloudflarestorage.com`;
    const objectUrl = (key: string) =>
      `https://${host}/${bucketName}/${key
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;

    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/sign") {
      const { key, contentType } = (await request.json()) as {
        key: string;
        contentType: string;
      };
      const target = new URL(objectUrl(key));
      target.searchParams.set("X-Amz-Expires", "300");
      const signer = new AwsV4Signer({
        method: "PUT",
        url: target.toString(),
        headers: { "content-type": contentType },
        accessKeyId,
        secretAccessKey,
        service: "s3",
        region: "auto",
        signQuery: true,
        allHeaders: true,
        appendSessionToken: false,
        singleEncode: true,
      });
      const signed = await signer.sign();
      return Response.json({ url: signed.url.toString() });
    }

    if (request.method === "GET" && url.pathname.startsWith("/file/")) {
      const key = decodeURIComponent(url.pathname.slice("/file/".length));
      const target = new URL(objectUrl(key));
      target.searchParams.set("X-Amz-Expires", "300");
      const signer = new AwsV4Signer({
        method: "GET",
        url: target.toString(),
        accessKeyId,
        secretAccessKey,
        service: "s3",
        region: "auto",
        signQuery: true,
        allHeaders: false,
        appendSessionToken: false,
        singleEncode: true,
      });
      const signed = await signer.sign();
      return Response.json({ url: signed.url.toString() });
    }

    return new Response("Not Found", { status: 404 });
  },
};