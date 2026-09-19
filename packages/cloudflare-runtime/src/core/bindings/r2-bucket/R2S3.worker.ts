import { parseRanges } from "../../internal/shared.worker.ts";
import { s3Error, verifyPresigned } from "./R2S3Auth.ts";
import { R2_S3_PATH, type R2S3Credentials } from "./R2S3Options.shared.ts";

interface Env {
  CREDENTIALS: R2S3Credentials;
  /** Bucket id -> internal binding name. Only locally bound buckets are exposed. */
  BUCKETS: Record<string, string>;
  UPSTREAM: Fetcher;
  [binding: `BUCKET_${number}`]: R2Bucket;
}

const cors = (request: Request, response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "*");
  if (request.method === "OPTIONS") {
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, PUT");
    headers.set(
      "Access-Control-Allow-Headers",
      request.headers.get("Access-Control-Request-Headers") ?? "*",
    );
    headers.set("Vary", "Access-Control-Request-Headers");
  }
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    headers,
  });
};

async function dispatch(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  const authError = await verifyPresigned(request, env.CREDENTIALS);
  if (authError) return authError;
  const path = url.pathname.slice(R2_S3_PATH.length);
  const separator = path.indexOf("/");
  let bucketName: string;
  let key: string;
  try {
    bucketName = decodeURIComponent(
      separator === -1 ? path : path.slice(0, separator),
    );
    key = separator === -1 ? "" : decodeURIComponent(path.slice(separator + 1));
  } catch {
    return s3Error(400, "InvalidArgument", "Invalid object path.");
  }
  const binding = Object.hasOwn(env.BUCKETS, bucketName)
    ? env.BUCKETS[bucketName]
    : undefined;
  if (!binding)
    return s3Error(
      404,
      "NoSuchBucket",
      "The specified local bucket does not exist.",
    );
  // This endpoint supports single-object presigned requests, not the full S3 API.
  if (
    !key ||
    !["GET", "HEAD", "PUT"].includes(request.method) ||
    [...url.searchParams.keys()].some(
      (name) =>
        !name.startsWith("X-Amz-") &&
        !name.toLowerCase().startsWith("x-amz-meta-") &&
        ![
          "x-id",
          "response-content-type",
          "response-content-disposition",
          "response-cache-control",
          "response-content-language",
          "response-content-encoding",
          "response-expires",
        ].includes(name),
    )
  ) {
    return s3Error(
      501,
      "NotImplemented",
      "Only presigned object PUT, GET and HEAD are supported.",
    );
  }
  const bucket = env[binding as `BUCKET_${number}`];
  if (request.method === "PUT") {
    // Do not silently accept encryption, multipart/chunked or checksum semantics
    // that this development endpoint does not implement.
    if (
      [...request.headers.keys()].some(
        (name) =>
          name.startsWith("x-amz-server-side-encryption") ||
          name.startsWith("x-amz-checksum-") ||
          name === "x-amz-storage-class" ||
          name === "content-md5",
      ) ||
      request.headers.get("content-encoding") === "aws-chunked"
    ) {
      return s3Error(
        501,
        "NotImplemented",
        "Encryption, storage classes and flexible checksums are not supported.",
      );
    }
    // AWS SDK presigners hoist custom metadata into the signed query.
    const customMetadata = Object.fromEntries(
      [...request.headers, ...url.searchParams]
        .filter(([name]) => name.toLowerCase().startsWith("x-amz-meta-"))
        .map(([name, value]) => [name.slice(11).toLowerCase(), value]),
    );
    const object = await bucket.put(key, request.body ?? new Uint8Array(), {
      httpMetadata: request.headers,
      customMetadata,
    });
    return new Response(null, { headers: { ETag: object.httpEtag } });
  }
  const body =
    request.method === "HEAD"
      ? null
      : await bucket.get(key, { range: request.headers });
  const object = request.method === "HEAD" ? await bucket.head(key) : body;
  if (!object)
    return s3Error(404, "NoSuchKey", "The specified key does not exist.");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Last-Modified", object.uploaded.toUTCString());
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(object.size));
  for (const [name, value] of Object.entries(object.customMetadata ?? {}))
    headers.set(`x-amz-meta-${name}`, value);
  for (const name of [
    "content-type",
    "content-disposition",
    "cache-control",
    "content-language",
    "content-encoding",
    "expires",
  ]) {
    const value = url.searchParams.get(`response-${name}`);
    if (value !== null) headers.set(name, value);
  }
  if (body) {
    const rangeHeader = request.headers.get("Range");
    const ranges =
      rangeHeader === null ? undefined : parseRanges(rangeHeader, object.size);
    // The native binding ignores invalid and multiple ranges, returning the
    // full object. Do not mistake its full-object range metadata for a 206.
    if (rangeHeader !== null && (ranges === undefined || ranges.length === 0)) {
      await body.body.cancel();
      const error = s3Error(
        416,
        "InvalidRange",
        "The requested range is not satisfiable.",
      );
      error.headers.set("Content-Range", `bytes */${object.size}`);
      return error;
    }
    const range = body.range;
    if (
      ranges?.length === 1 &&
      range &&
      "offset" in range &&
      range.offset !== undefined &&
      range.length !== undefined
    ) {
      headers.set("Content-Length", String(range.length));
      headers.set(
        "Content-Range",
        `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
      );
      return new Response(body.body, { status: 206, headers });
    }
    return new Response(body.body, { headers });
  }
  return new Response(null, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(R2_S3_PATH))
      return env.UPSTREAM.fetch(request);
    try {
      return cors(request, await dispatch(request, env, url));
    } catch {
      return cors(
        request,
        s3Error(500, "InternalError", "The local R2 operation failed."),
      );
    }
  },
} satisfies ExportedHandler<Env>;
