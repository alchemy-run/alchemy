// Alchemy modifications are licensed under Apache-2.0.
// Adapted from Cloudflare workers-sdk/packages/miniflare/src/workers/r2/s3/auth.worker.ts.
// Upstream revision: 43b1f85fe26d4b1568f6d7aacc7ffba2b408419b.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import type { R2S3Credentials } from "./R2S3Options.shared.ts";

const encoder = new TextEncoder();
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
const sha256 = async (value: string) =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
const hmac = async (key: BufferSource, value: string) => {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", imported, encoder.encode(value));
};

export const s3Error = (
  status: number,
  code: string,
  message: string,
): Response =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
    {
      status,
      headers: { "Content-Type": "application/xml" },
    },
  );

/** Verify the full public request URL before decoding its bucket or object key. */
export async function verifyPresigned(
  request: Request,
  credentials: R2S3Credentials,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const params = url.searchParams;
  const invalid = () =>
    s3Error(
      400,
      "InvalidArgument",
      "Invalid presigned URL authentication parameters.",
    );
  const fields = [
    "X-Amz-Algorithm",
    "X-Amz-Credential",
    "X-Amz-Date",
    "X-Amz-Expires",
    "X-Amz-SignedHeaders",
    "X-Amz-Signature",
  ];
  if (fields.some((field) => params.getAll(field).length !== 1))
    return invalid();
  if (params.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256") return invalid();
  // Session credentials and header authentication are outside this endpoint's scope.
  if (
    params.has("X-Amz-Security-Token") ||
    request.headers.has("Authorization")
  )
    return invalid();
  const [accessKeyId, date, region, service, terminator, extra] = params
    .get("X-Amz-Credential")!
    .split("/");
  const amzDate = params.get("X-Amz-Date")!;
  if (
    !/^\d{8}T\d{6}Z$/.test(amzDate) ||
    date !== amzDate.slice(0, 8) ||
    !region ||
    service !== "s3" ||
    terminator !== "aws4_request" ||
    extra !== undefined
  )
    return invalid();
  const timestamp = Date.parse(
    amzDate.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
      "$1-$2-$3T$4:$5:$6Z",
    ),
  );
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().replace(/[:-]|\.\d{3}/g, "") !== amzDate
  )
    return invalid();
  const expiry = params.get("X-Amz-Expires")!;
  if (!/^\d+$/.test(expiry) || Number(expiry) < 1 || Number(expiry) > 604800)
    return invalid();
  if (Date.now() > timestamp + Number(expiry) * 1000)
    return s3Error(403, "ExpiredRequest", "Request has expired.");
  if (timestamp > Date.now() + 15 * 60 * 1000)
    return s3Error(
      403,
      "RequestTimeTooSkewed",
      "Request time is too far in the future.",
    );
  if (accessKeyId !== credentials.accessKeyId)
    return s3Error(
      403,
      "InvalidAccessKeyId",
      "Unknown development access key.",
    );
  const signedHeaders = params.get("X-Amz-SignedHeaders")!.split(";");
  if (
    !signedHeaders.includes("host") ||
    signedHeaders.some(
      (name, index) =>
        !/^[a-z0-9-]+$/.test(name) ||
        (index > 0 && name <= signedHeaders[index - 1]) ||
        (name !== "host" && !request.headers.has(name)),
    )
  )
    return invalid();
  const signature = params.get("X-Amz-Signature")!;
  if (!/^[0-9a-f]{64}$/.test(signature)) return invalid();
  const query = [...params]
    .filter(([name]) => name !== "X-Amz-Signature")
    .map(([name, value]) => [encode(name), encode(value)])
    .sort(([a, av], [b, bv]) =>
      a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const headers = signedHeaders
    .map(
      (name) =>
        `${name}:${(name === "host" ? url.host : request.headers.get(name)!).trim().replace(/\s+/g, " ")}\n`,
    )
    .join("");
  const canonical = [
    request.method,
    url.pathname,
    query,
    headers,
    signedHeaders.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256(canonical),
  ].join("\n");
  let key = await hmac(
    encoder.encode(`AWS4${credentials.secretAccessKey}`),
    date,
  );
  key = await hmac(key, region);
  key = await hmac(key, "s3");
  key = await hmac(key, "aws4_request");
  const expected = hex(await hmac(key, stringToSign));
  return crypto.subtle.timingSafeEqual(
    encoder.encode(expected),
    encoder.encode(signature),
  )
    ? undefined
    : s3Error(
        403,
        "SignatureDoesNotMatch",
        "The request signature does not match.",
      );
}
