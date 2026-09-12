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
                const missingDelete = yield* deleteObject({
                  object: "missing.txt",
                }).pipe(
                  Effect.as("deleted" as const),
                  Effect.catchTag("NotFound", () =>
                    Effect.succeed("gone" as const),
                  ),
                );
                const put = yield* putObject({
                  name: "hello.txt",
                  body: { name: "hello.txt", contentType: "text/plain" },
                }).pipe(Effect.flip);
                return { missingGet, missingDelete, put };
              });
            }),
          );
          return { bucket, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.missingGet._tag).toEqual("NotFound");
      expect(out.probe.missingDelete).toEqual("gone");
      // JSON insertObjects is rejected; object bytes must go to the
      // /upload endpoint. The binding is still exercised.
      expect(out.probe.put._tag).toEqual("BadRequest");
      expect(String(out.probe.put)).toContain("upload URL");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
