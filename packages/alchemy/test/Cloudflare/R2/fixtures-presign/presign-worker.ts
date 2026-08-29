import { AwsV4Signer } from "aws4fetch";

/**
 * The example worker's signing logic — extracted here so we can
 * exercise it in unit tests without a live deploy. The worker reads
 * the four `R2_PRESIGN_*` bindings registered by
 * {@link Cloudflare.R2.PresignedUrlBinding} and signs URLs with
 * `aws4fetch.AwsV4Signer`. Identical to `src/worker.ts` in
 * `examples/cloudflare-r2-presigned-upload/`.
 */
export interface PresignEnv {
  readonly R2_PRESIGN_ACCESS_KEY_ID: string;
  readonly R2_PRESIGN_SECRET_ACCESS_KEY: { get(): Promise<string> };
  readonly R2_PRESIGN_ACCOUNT_ID: string;
  readonly R2_PRESIGN_BUCKET_NAME: string;
}

const objectUrl = (env: PresignEnv, key: string): string =>
  `https://${env.R2_PRESIGN_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_PRESIGN_BUCKET_NAME}/${key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;

const sign = async (
  env: PresignEnv,
  method: "PUT" | "GET",
  key: string,
  headers: Record<string, string> = {},
  expiresIn = 300,
): Promise<string> => {
  const accessKeyId = env.R2_PRESIGN_ACCESS_KEY_ID;
  const secretAccessKey = await env.R2_PRESIGN_SECRET_ACCESS_KEY.get();

  const target = new URL(objectUrl(env, key));
  target.searchParams.set("X-Amz-Expires", String(expiresIn));

  const signer = new AwsV4Signer({
    method,
    url: target.toString(),
    headers,
    accessKeyId,
    secretAccessKey,
    service: "s3",
    region: "auto",
    signQuery: true,
    allHeaders: Object.keys(headers).length > 0,
    appendSessionToken: false,
    singleEncode: true,
  });
  const signed = await signer.sign();
  return signed.url.toString();
};

export const presignWorkerHandler = async (
  request: Request,
  env: PresignEnv,
): Promise<Response> => {
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/sign") {
    const { key, contentType } = (await request.json()) as {
      key: string;
      contentType: string;
    };
    const signed = await sign(env, "PUT", key, { "content-type": contentType });
    return new Response(JSON.stringify({ url: signed }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (request.method === "GET" && url.pathname.startsWith("/file/")) {
    const key = decodeURIComponent(url.pathname.slice("/file/".length));
    const signed = await sign(env, "GET", key);
    return new Response(JSON.stringify({ url: signed }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response("Not Found", { status: 404 });
};
