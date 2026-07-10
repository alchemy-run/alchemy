import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import * as S3 from "@distilled.cloud/aws/s3";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";

import S3PresignTestFunctionLive, {
  S3PresignTestFunction,
} from "./fixtures/presign-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "S3Bindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take
// well over 60s on a fresh deploy under parallel-suite load. Budget ~150s
// of readiness polling so we don't fail the whole suite on a slow init.
const readinessPolicy = Schedule.fixed("2 seconds").pipe(
  Schedule.both(Schedule.recurs(75)),
);

let baseUrl: string;
let bucketName: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under
// parallel load (cold re-init). Retry only 5xx; a genuine 4xx/assertion
// failure is surfaced immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.both(Schedule.recurs(6)),
      ),
    }),
  );

// Mint a presigned URL via the deployed Lambda fixture.
const presign = (
  op: "presign-get" | "presign-put",
  params: { key: string; expiresIn?: number; contentType?: string },
) =>
  Effect.gen(function* () {
    const search = new URLSearchParams({ key: params.key });
    if (params.expiresIn !== undefined) {
      search.set("expiresIn", String(params.expiresIn));
    }
    if (params.contentType !== undefined) {
      search.set("contentType", params.contentType);
    }
    const response = yield* send(
      HttpClientRequest.get(`${baseUrl}/${op}?${search.toString()}`),
    );
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { url: string };
    expect(body.url).toContain("X-Amz-Signature=");
    return body.url;
  });

class IamNotPropagated extends Data.TaggedError("IamNotPropagated")<{
  readonly status: number;
  readonly body: string;
}> {}

// The Lambda role's inline policy can take a few seconds to propagate after
// deploy — a structurally valid presigned URL answers 403 until it does.
// Retry 403s on a bounded schedule; any other failure surfaces immediately.
const sendPresigned = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status === 403
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new IamNotPropagated({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "IamNotPropagated",
      schedule: Schedule.exponential("1 second").pipe(
        Schedule.both(Schedule.recurs(8)),
      ),
    }),
  );

describe("S3 Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("S3 test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("S3 test setup: deploying presign fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* S3PresignTestFunction;
        }).pipe(Effect.provide(S3PresignTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/bucket-name`;

      yield* Effect.logInfo(
        `S3 test setup: probing readiness at ${readinessUrl}`,
      );
      // The fixture answers 503 until the runtime hydrates resource
      // Outputs (first-event race after a cold start) — keep retrying
      // until it serves the bucket name.
      const ready = yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.json
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `S3 test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
      bucketName = (ready as { bucketName: string }).bucketName;
      expect(bucketName).toBeTruthy();
      yield* Effect.logInfo(
        `S3 test setup: fixture ready (bucket ${bucketName})`,
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("PresignPutObject", () => {
    test.provider(
      "uploads a body via a Lambda-minted presigned PUT URL",
      (_stack) =>
        Effect.gen(function* () {
          const key = "presign/upload.txt";
          const body = "uploaded through a presigned PUT URL";

          const url = yield* presign("presign-put", {
            key,
            contentType: "text/plain",
          });

          const putResponse = yield* sendPresigned(
            HttpClientRequest.put(url).pipe(
              HttpClientRequest.bodyText(body, "text/plain"),
            ),
          );
          expect(putResponse.status).toBe(200);

          // out-of-band verification via distilled — the object really landed
          const head = yield* S3.headObject({ Bucket: bucketName, Key: key });
          expect(head.ContentLength).toBe(body.length);
          expect(head.ContentType).toBe("text/plain");
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "rejects an upload whose Content-Type does not match the signature",
      (_stack) =>
        Effect.gen(function* () {
          const url = yield* presign("presign-put", {
            key: "presign/mismatched.txt",
            contentType: "text/plain",
          });

          // Signed for text/plain but sent as application/json — the
          // signature no longer matches, so S3 must reject it.
          const response = yield* HttpClient.execute(
            HttpClientRequest.put(url).pipe(
              HttpClientRequest.bodyText("{}", "application/json"),
            ),
          );
          expect(response.status).toBe(403);
        }),
      { timeout: 120_000 },
    );
  });

  describe("PresignGetObject", () => {
    test.provider(
      "round-trips a body through presigned PUT and GET URLs",
      (_stack) =>
        Effect.gen(function* () {
          const key = "presign/round-trip.txt";
          const body = "presigned round trip payload";

          const putUrl = yield* presign("presign-put", {
            key,
            contentType: "text/plain",
          });
          const putResponse = yield* sendPresigned(
            HttpClientRequest.put(putUrl).pipe(
              HttpClientRequest.bodyText(body, "text/plain"),
            ),
          );
          expect(putResponse.status).toBe(200);

          const getUrl = yield* presign("presign-get", { key });
          const getResponse = yield* sendPresigned(
            HttpClientRequest.get(getUrl),
          );
          expect(getResponse.status).toBe(200);
          expect(yield* getResponse.text).toBe(body);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "overrides the response Content-Type via contentType",
      (_stack) =>
        Effect.gen(function* () {
          const key = "presign/override.txt";

          // seed the object out-of-band via distilled
          yield* S3.putObject({
            Bucket: bucketName,
            Key: key,
            Body: "override me",
            ContentType: "text/plain",
          });

          const getUrl = yield* presign("presign-get", {
            key,
            contentType: "application/octet-stream",
          });
          const getResponse = yield* sendPresigned(
            HttpClientRequest.get(getUrl),
          );
          expect(getResponse.status).toBe(200);
          expect(getResponse.headers["content-type"]).toBe(
            "application/octet-stream",
          );
          expect(yield* getResponse.text).toBe("override me");
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "expired presigned URLs are rejected",
      (_stack) =>
        Effect.gen(function* () {
          const key = "presign/expiring.txt";
          yield* S3.putObject({
            Bucket: bucketName,
            Key: key,
            Body: "short lived",
          });

          const getUrl = yield* presign("presign-get", {
            key,
            expiresIn: 1,
          });

          // Poll until S3 reports the URL expired (bounded — expiry is 1s,
          // allow a little clock skew between the Lambda signer and S3).
          const status = yield* Effect.gen(function* () {
            const response = yield* HttpClient.execute(
              HttpClientRequest.get(getUrl),
            );
            return response.status;
          }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (status) => status === 403,
              times: 8,
            }),
          );
          expect(status).toBe(403);
        }),
      { timeout: 120_000 },
    );
  });
});
