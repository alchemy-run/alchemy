#!/usr/bin/env bun
/**
 * Live end-to-end smoke test for the R2 presign flow.
 *
 * Reads R2 credentials from ~/Documents/seenkw/.env (minted once in the
 * Cloudflare dashboard: R2 → Manage R2 API Tokens → Create Token) and:
 *
 *   1. creates a fresh R2 bucket via the Cloudflare REST API
 *   2. signs a PUT URL with the R2 access keys (Web Crypto SigV4)
 *   3. uploads a payload to R2 via the signed URL
 *   4. signs a GET URL and downloads the payload back
 *   5. deletes the bucket
 *
 * This is the canonical end-to-end test of the presign flow — it
 * validates the URL SigV4 signing works against the real R2 endpoint.
 *
 * Note: Cloudflare OAuth tokens (from `alchemy login`) cannot mint
 * R2 API tokens — Cloudflare's REST API rejects OAuth tokens on the
 * token-management endpoints (`POST /accounts/{id}/tokens`). R2 keys
 * must be minted via the dashboard once per account.
 *
 * Run with:
 *   bun packages/alchemy/scripts/presign-live-smoke.ts
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const envPath = join(homedir(), "Documents", "seenkw", ".env");
const envText = await readFile(envPath, "utf-8");
const env: Record<string, string> = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
}

const accessKeyId = env.CLOUDFLARE_R2_ACCESS_KEY_ID;
const secretAccessKey = env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
const accountId = env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = env.CLOUDFLARE_API_TOKEN;

if (!accessKeyId || !secretAccessKey || !accountId || !apiToken) {
  console.error(
    "Missing one of CLOUDFLARE_R2_ACCESS_KEY_ID / CLOUDFLARE_R2_SECRET_ACCESS_KEY / CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN in ~/Documents/seenkw/.env",
  );
  process.exit(1);
}

const API_BASE = "https://api.cloudflare.com/client/v4";
const authHeaders = { Authorization: `Bearer ${apiToken}` };

// --- Step 1 — create a fresh bucket -------------------------------------

const bucketName = `alchemy-presign-smoke-${Date.now()}`;

const bucketRes = await fetch(`${API_BASE}/accounts/${accountId}/r2/buckets`, {
  method: "POST",
  headers: { ...authHeaders, "Content-Type": "application/json" },
  body: JSON.stringify({ name: bucketName }),
});
if (!bucketRes.ok) {
  console.error(
    `Bucket create failed (${bucketRes.status}):`,
    await bucketRes.text(),
  );
  process.exit(1);
}
console.log(`Created bucket: ${bucketName}`);

// --- Step 2 — sign a PUT URL with Web Crypto SigV4 -------------------------

const host = `${accountId}.r2.cloudflarestorage.com`;
const objectUrl = (key: string) =>
  `https://${host}/${bucketName}/${key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;

const body = `Hello from alchemy presign smoke @ ${new Date().toISOString()}`;
const expiresIn = 300;

const now = new Date();
const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, "");
const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
const region = "auto";
const service = "s3";

const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
const credential = `${accessKeyId}/${credentialScope}`;

async function sha256Hex(input: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256(
  key: ArrayBuffer,
  message: string,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(message),
  );
}

async function getSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(
    new TextEncoder().encode("AWS4" + secretKey).buffer as ArrayBuffer,
    dateStamp,
  );
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return await hmacSha256(kService, "aws4_request");
}

const signObjectUrl = async (
  method: "PUT" | "GET",
  key: string,
  contentType?: string,
): Promise<{ url: string; headers: Record<string, string> }> => {
  const target = new URL(objectUrl(key));
  target.searchParams.set("X-Amz-Expires", String(expiresIn));

  const signedHeaders: string[] = ["host"];
  if (contentType) signedHeaders.push("content-type");
  signedHeaders.sort();

  const queryParams = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": signedHeaders.join(";"),
  });
  const canonicalQueryString = Array.from(queryParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalHeaders =
    signedHeaders
      .map((h) =>
        h === "content-type" ? `${h}:${contentType}` : `${h}:${host}`,
      )
      .join("\n") + "\n";

  const canonicalRequest = [
    method,
    `/${bucketName}/${key}`,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = await getSigningKey(
    secretAccessKey,
    dateStamp,
    region,
    service,
  );
  const signatureBytes = await hmacSha256(signingKey, stringToSign);
  const signature = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const url = `${objectUrl(key)}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
  const headers: Record<string, string> = {};
  if (contentType) headers["content-type"] = contentType;
  return { url, headers };
};

// --- Step 3 — upload via the signed URL -------------------------------------

const putSigned = await signObjectUrl("PUT", "hello.txt", "text/plain");
console.log(`\n=== Signed PUT URL ===\n${putSigned.url}`);

const uploadRes = await fetch(putSigned.url, {
  method: "PUT",
  body,
  headers: putSigned.headers,
});

if (!uploadRes.ok) {
  console.error(
    `\n✗ Upload failed: ${uploadRes.status} ${uploadRes.statusText}`,
  );
  console.error(await uploadRes.text());
  await fetch(`${API_BASE}/accounts/${accountId}/r2/buckets/${bucketName}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  process.exit(1);
}
console.log(
  `\n✓ Upload succeeded: ${uploadRes.status} ${uploadRes.statusText}`,
);

// --- Step 4 — GET it back ---------------------------------------------------

const getSigned = await signObjectUrl("GET", "hello.txt");
const getRes = await fetch(getSigned.url);
if (!getRes.ok) {
  console.error(`✗ GET failed: ${getRes.status}`);
  await fetch(`${API_BASE}/accounts/${accountId}/r2/buckets/${bucketName}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  process.exit(1);
}
const got = await getRes.text();
console.log(`✓ GET returned: ${got}`);
if (got !== body) {
  console.error(
    `✗ Body mismatch:\n  got: ${JSON.stringify(got)}\n  want: ${JSON.stringify(body)}`,
  );
  await fetch(`${API_BASE}/accounts/${accountId}/r2/buckets/${bucketName}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  process.exit(1);
}

// --- Step 5 — cleanup -------------------------------------------------------

await fetch(`${API_BASE}/accounts/${accountId}/r2/buckets/${bucketName}`, {
  method: "DELETE",
  headers: authHeaders,
});

console.log(`\n=== End-to-end presign flow succeeded! ===`);
console.log(`  - Account: ${accountId}`);
console.log(`  - Bucket: ${bucketName}`);
console.log(`  - PUT ${body.length} bytes → ${uploadRes.status}`);
console.log(`  - GET back same ${got.length} bytes`);
console.log(`  - Deleted bucket ${bucketName}`);
