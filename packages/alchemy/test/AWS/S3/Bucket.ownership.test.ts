import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import {
  accountId,
  bucketName,
  bucketProvider,
  error,
  fixture,
  instanceId,
  provideBucket,
  session,
  xml,
} from "./fixtures/bucket-provider.ts";

const read = Effect.gen(function* () {
  const provider = yield* bucketProvider;
  return yield* provider.read!({
    id: "Bucket",
    fqn: "Bucket",
    instanceId,
    olds: { bucketName },
    output: undefined,
  });
});

const precreate = Effect.gen(function* () {
  const provider = yield* bucketProvider;
  return yield* provider.precreate!({
    id: "Bucket",
    fqn: "Bucket",
    instanceId,
    news: { bucketName },
    session,
    bindings: [],
  });
});

describe("Bucket ownership admission", () => {
  it.effect(
    "reads a bucket through an ownership-checked configuration request",
    () =>
      Effect.gen(function* () {
        const transport = fixture((call) =>
          call.method === "GET" && call.query.has("location")
            ? xml("<LocationConstraint/>")
            : error("AccessDenied", 403),
        );
        const bucket = yield* provideBucket(read, transport.environment);
        expect(bucket?.bucketName).toBe(bucketName);
        expect(transport.calls).toHaveLength(1);
        expect(
          transport.calls[0]!.request.headers["x-amz-expected-bucket-owner"],
        ).toBe(accountId);
      }),
  );

  it.effect("returns missing only for NoSuchBucket", () =>
    Effect.gen(function* () {
      const transport = fixture(() => error("NoSuchBucket", 404));
      expect(yield* provideBucket(read, transport.environment)).toBeUndefined();
    }),
  );

  it.effect(
    "propagates AccessDenied instead of reporting an absent bucket",
    () =>
      Effect.gen(function* () {
        const transport = fixture(() => error("AccessDenied", 403));
        const failure = yield* provideBucket(read, transport.environment).pipe(
          Effect.flip,
        );
        expect(failure._tag).toBe("AccessDeniedException");
      }),
  );

  it.effect(
    "propagates transport failures instead of reporting an absent bucket",
    () =>
      Effect.gen(function* () {
        const transport = fixture(({ request }) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new Error("connection closed"),
              }),
            }),
          ),
        );
        yield* provideBucket(read, transport.environment).pipe(Effect.flip);
        expect(transport.calls.length).toBeGreaterThan(0);
      }),
  );

  it.effect(
    "does not recreate an existing us-east-1 bucket without ListBucket",
    () =>
      Effect.gen(function* () {
        const transport = fixture((call) =>
          call.query.has("location")
            ? xml("<LocationConstraint/>")
            : error("AccessDenied", 403),
        );
        const bucket = yield* provideBucket(precreate, transport.environment);
        expect(bucket.bucketName).toBe(bucketName);
        expect(
          transport.calls.every(
            (call) => call.method === "GET" && call.query.has("location"),
          ),
        ).toBe(true);
        expect(
          transport.calls.every(
            (call) =>
              call.request.headers["x-amz-expected-bucket-owner"] === accountId,
          ),
        ).toBe(true);
      }),
  );

  it.effect(
    "creates after an explicit absence and verifies the expected owner",
    () =>
      Effect.gen(function* () {
        let created = false;
        const transport = fixture((call) => {
          if (call.method === "PUT") {
            created = true;
            return xml("");
          }
          return created
            ? xml("<LocationConstraint/>")
            : error("NoSuchBucket", 404);
        });
        yield* provideBucket(precreate, transport.environment);
        expect(transport.calls.map((call) => call.method)).toEqual([
          "GET",
          "PUT",
          "GET",
        ]);
        expect(
          transport.calls[2]!.request.headers["x-amz-expected-bucket-owner"],
        ).toBe(accountId);
      }),
  );

  it.effect(
    "never creates a bucket after an ownership or permission rejection",
    () =>
      Effect.gen(function* () {
        const transport = fixture(() => error("AccessDenied", 403));
        const failure = yield* provideBucket(
          precreate,
          transport.environment,
        ).pipe(Effect.flip);
        expect(failure._tag).toBe("AccessDeniedException");
        expect(transport.calls).toHaveLength(1);
        expect(transport.calls[0]!.method).toBe("GET");
      }),
  );

  it.effect(
    "fails readiness immediately on authorization errors after a regional create",
    () =>
      Effect.gen(function* () {
        const transport = fixture(
          (call) =>
            call.method === "PUT" ? xml("") : error("AccessDenied", 403),
          "eu-west-1",
        );
        const failure = yield* provideBucket(
          precreate,
          transport.environment,
        ).pipe(Effect.flip);
        expect(failure._tag).toBe("AccessDeniedException");
        expect(transport.calls.map((call) => call.method)).toEqual([
          "PUT",
          "GET",
        ]);
        expect(
          transport.calls[1]!.request.headers["x-amz-expected-bucket-owner"],
        ).toBe(accountId);
      }),
  );
});
