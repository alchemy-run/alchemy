import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import {
  bucketName,
  bucketProvider,
  error,
  existingBucket,
  fixture,
  instanceId,
  output,
  provideBucket,
  session,
  xml,
  type Call,
} from "./fixtures/bucket-provider.ts";

const reconcile = (aspect: "tagging" | "encryption") =>
  Effect.gen(function* () {
    const provider = yield* bucketProvider;
    yield* provider.reconcile({
      id: "Bucket",
      fqn: "Bucket",
      instanceId,
      news: {
        bucketName,
        ...(aspect === "tagging"
          ? { tags: { managed: "yes" } }
          : { encryption: { sseAlgorithm: "AES256" as const } }),
      },
      olds: undefined,
      output,
      session,
      bindings: [],
    });
  });

for (const aspect of ["tagging", "encryption"] as const) {
  describe(`Bucket ${aspect} observation`, () => {
    const observe = (
      read: (
        call: Call,
      ) =>
        | ReturnType<typeof error>
        | Effect.Effect<never, HttpClientError.HttpClientError>,
    ) =>
      fixture((call) => {
        if (call.query.has(aspect))
          return call.method === "GET" ? read(call) : xml("");
        return existingBucket(call);
      });

    it.effect("does not write after AccessDenied", () =>
      Effect.gen(function* () {
        const transport = observe(() => error("AccessDenied", 403));
        const failure = yield* provideBucket(
          reconcile(aspect),
          transport.environment,
        ).pipe(Effect.flip);
        expect(failure._tag).toBe("AccessDeniedException");
        expect(
          transport.calls.filter(
            (call) => call.method !== "GET" && call.query.has(aspect),
          ),
        ).toEqual([]);
      }),
    );

    it.effect("does not write after a transport failure", () =>
      Effect.gen(function* () {
        const transport = observe(({ request }) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new Error("connection closed"),
              }),
            }),
          ),
        );
        yield* provideBucket(reconcile(aspect), transport.environment).pipe(
          Effect.flip,
        );
        expect(
          transport.calls.filter(
            (call) => call.method !== "GET" && call.query.has(aspect),
          ),
        ).toEqual([]);
      }),
    );

    it.effect("still initializes explicitly absent configuration", () =>
      Effect.gen(function* () {
        const transport = observe(() =>
          aspect === "tagging"
            ? error("NoSuchTagSet", 404)
            : xml("<ServerSideEncryptionConfiguration/>"),
        );
        yield* provideBucket(reconcile(aspect), transport.environment);
        expect(
          transport.calls.filter(
            (call) => call.method === "PUT" && call.query.has(aspect),
          ),
        ).toHaveLength(1);
      }),
    );

    it.effect("does not turn a missing bucket into missing configuration", () =>
      Effect.gen(function* () {
        const transport = observe(() => error("NoSuchBucket", 404));
        const failure = yield* provideBucket(
          reconcile(aspect),
          transport.environment,
        ).pipe(Effect.flip);
        expect(failure._tag).toBe("NoSuchBucket");
        expect(
          transport.calls.filter(
            (call) => call.method !== "GET" && call.query.has(aspect),
          ),
        ).toEqual([]);
      }),
    );
  });
}
