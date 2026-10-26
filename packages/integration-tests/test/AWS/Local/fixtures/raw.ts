import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
/**
 * Raw (non-distilled) HTTP helpers against the floci emulator gateway —
 * out-of-band proof that a resource exists IN THE EMULATOR, not the real
 * cloud. The JSON and query helpers send a dummy SigV4 Authorization header
 * that only carries the service/region/account scoping the gateway routes by;
 * the S3 helpers sign for real.
 */
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

export const FLOCI_ENDPOINT = "http://localhost:4566";

/**
 * skipIf gate: floci runs as a Docker container. `docker info` proves the
 * daemon is reachable (a mere `docker --version` would pass with the daemon
 * down). Sync probe at collection time — skipIf needs a plain boolean.
 */
export const dockerAvailable = (() => {
  try {
    return spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status === 0;
  } catch {
    return false;
  }
})();

/** POST an AWS-JSON operation straight at the emulator gateway. */
export const rawAwsJson = Effect.fn(function* (options: {
  service: string;
  region: string;
  target: string;
  contentType: string;
  body: Record<string, unknown>;
}) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.execute(
    HttpClientRequest.post(`${FLOCI_ENDPOINT}/`).pipe(
      HttpClientRequest.setHeaders({
        "content-type": options.contentType,
        "x-amz-target": options.target,
        "x-amz-date": "20260101T000000Z",
        authorization: `AWS4-HMAC-SHA256 Credential=test/20260101/${options.region}/${options.service}/aws4_request, SignedHeaders=host;x-amz-date, Signature=dummy`,
      }),
      HttpClientRequest.setBody(HttpBody.text(JSON.stringify(options.body), options.contentType)),
    ),
  );
});

/** POST an AWS query-protocol operation (SNS, …) straight at the gateway. */
export const rawAwsQuery = Effect.fn(function* (options: {
  service: string;
  region: string;
  params: Record<string, string>;
}) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.execute(
    HttpClientRequest.post(`${FLOCI_ENDPOINT}/`).pipe(
      HttpClientRequest.setHeaders({
        "content-type": "application/x-www-form-urlencoded",
        "x-amz-date": "20260101T000000Z",
        authorization: `AWS4-HMAC-SHA256 Credential=test/20260101/${options.region}/${options.service}/aws4_request, SignedHeaders=host;x-amz-date, Signature=dummy`,
      }),
      HttpClientRequest.setBody(
        HttpBody.text(
          new URLSearchParams(options.params).toString(),
          "application/x-www-form-urlencoded",
        ),
      ),
    ),
  );
});

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) =>
  createHmac("sha256", key).update(value).digest();

/**
 * Path-style S3 GET against the gateway. Unlike the JSON calls above, it carries a real SigV4
 * signature for Floci's `test`/`test` credentials: the suites run Floci with S3 auth
 * enforcement, which verifies S3 signatures.
 */
const rawS3Get = Effect.fn(function* (path: string) {
  const client = yield* HttpClient.HttpClient;
  const headers = yield* Effect.sync(() => {
    const amzDate = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
    const day = amzDate.slice(0, 8);
    const host = new URL(FLOCI_ENDPOINT).host;
    const payloadHash = sha256Hex("");
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [
      "GET",
      path,
      "",
      `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const scope = `${day}/us-east-1/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join(
      "\n",
    );
    const signingKey = hmac(hmac(hmac(hmac("AWS4test", day), "us-east-1"), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    return {
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      authorization: `AWS4-HMAC-SHA256 Credential=test/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  });
  return yield* client.execute(
    HttpClientRequest.get(`${FLOCI_ENDPOINT}${path}`).pipe(HttpClientRequest.setHeaders(headers)),
  );
});

/** Path-style S3 GET against the gateway (list the bucket's objects). */
export const rawS3GetBucket = (bucketName: string) => rawS3Get(`/${bucketName}`);

/** Path-style S3 object GET against the gateway. */
export const rawS3GetObject = (bucketName: string, key: string) =>
  rawS3Get(`/${bucketName}/${key}`);

/** Region segment of an ARN (`arn:aws:sqs:REGION:ACCOUNT:name`). */
export const regionOfArn = (arn: string) => arn.split(":")[3]!;
