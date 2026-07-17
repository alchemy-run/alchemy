/**
 * Minimal AWS Signature Version 4 request signing.
 *
 * Plain TypeScript (node:crypto only) because it is bundled into the bridge
 * Lambda; the local side reuses it through {@link AppSyncEventsClient}.
 */
import * as crypto from "node:crypto";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignableRequest {
  method: string;
  url: URL;
  /** Lower-case header names. `host` is derived from the URL. */
  headers: Record<string, string>;
  body: string;
}

const hmac = (key: string | Uint8Array, data: string) =>
  crypto.createHmac("sha256", key).update(data, "utf8").digest();

const hex = (data: string | Uint8Array) =>
  crypto.createHash("sha256").update(data).digest("hex");

/**
 * Signs the request, returning the full header set to send (input headers
 * plus `host`, `x-amz-date`, `x-amz-security-token` and `authorization`).
 */
export const signRequest = (
  request: SignableRequest,
  options: {
    credentials: AwsCredentials;
    region: string;
    service: string;
    date?: Date;
  },
): Record<string, string> => {
  const { credentials, region, service } = options;
  const now = options.date ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]),
    ),
    host: request.url.host,
    "x-amz-date": amzDate,
  };
  if (credentials.sessionToken) {
    headers["x-amz-security-token"] = credentials.sessionToken;
  }

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name].trim()}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const payloadHash = hex(request.body);

  const canonicalQuery = [...request.url.searchParams.entries()]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join("&");

  const canonicalRequest = [
    request.method,
    request.url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto
    .createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
};
