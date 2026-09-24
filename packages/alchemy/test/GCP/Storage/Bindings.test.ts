import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

test.provider.skipIf(!hasGcpCreds)(
  "PutObject, GetObject, and DeleteObject round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("Assets", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* bucket.bucketName;
              const putObject = yield* GCP.Storage.PutObject(bucket);
              const getObject = yield* GCP.Storage.GetObject(bucket);
              const deleteObject = yield* GCP.Storage.DeleteObject(bucket);
              return Effect.fn(function* () {
                const missingGet = yield* getObject({
                  object: "missing.txt",
                }).pipe(Effect.flip);
                const put = yield* putObject({
                  name: "hello.txt",
                  body: "Hello, GCS!",
                });
                const got = yield* getObject({ object: "hello.txt" });
                const overwritten = yield* putObject({
                  name: "hello.txt",
                  body: new TextEncoder().encode("v2"),
                  contentType: "application/octet-stream",
                  metadata: { source: "test" },
                });
                const again = yield* getObject({ object: "hello.txt" });
                yield* deleteObject({ object: "hello.txt" });
                const afterDelete = yield* getObject({
                  object: "hello.txt",
                }).pipe(Effect.flip);
                const missingDelete = yield* deleteObject({
                  object: "missing.txt",
                }).pipe(
                  Effect.as("deleted" as const),
                  Effect.catchTag("NotFound", () =>
                    Effect.succeed("gone" as const),
                  ),
                );
                return {
                  missingGet: missingGet._tag,
                  putName: put.name,
                  text: new TextDecoder().decode(got.body),
                  contentType: got.contentType,
                  overwrittenMetadata: overwritten.metadata,
                  againText: new TextDecoder().decode(again.body),
                  afterDelete: afterDelete._tag,
                  missingDelete,
                };
              });
            }),
          );
          return { bucket, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.missingGet).toEqual("GCP.Storage.ObjectNotFound");
      expect(out.probe.putName).toEqual("hello.txt");
      expect(out.probe.text).toEqual("Hello, GCS!");
      expect(out.probe.contentType).toContain("text/plain");
      expect(out.probe.overwrittenMetadata).toEqual({ source: "test" });
      expect(out.probe.againText).toEqual("v2");
      expect(out.probe.afterDelete).toEqual("GCP.Storage.ObjectNotFound");
      expect(out.probe.missingDelete).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
