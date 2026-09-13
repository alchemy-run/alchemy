import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Data from "effect/Data";
import * as Path from "node:path";
class RestartPending extends Data.TaggedError("RestartPending") {}
const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

test.provider(
  "R2 local lifecycle expires, transitions tiers, aborts multipart, and respects locks",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (active: boolean) =>
        Effect.gen(function* () {
          const bucket = yield* Cloudflare.R2.Bucket("LifecycleBucket", {
            storageClass: active ? "Standard" : "InfrequentAccess",
            lockRules: [
              {
                id: "retained",
                prefix: "protected/",
                condition: { type: "Indefinite" },
              },
            ],
            lifecycleRules: active
              ? [
                  {
                    id: "expire",
                    prefix: "expire/",
                    deleteObjectsTransition: {
                      condition: {
                        type: "Date",
                        date: "2020-01-01T00:00:00.000Z",
                      },
                    },
                  },
                  {
                    id: "lock-wins",
                    prefix: "protected/",
                    deleteObjectsTransition: {
                      condition: {
                        type: "Date",
                        date: "2020-01-01T00:00:00.000Z",
                      },
                    },
                  },
                  {
                    id: "archive",
                    prefix: "archive/",
                    storageClassTransitions: [
                      {
                        storageClass: "InfrequentAccess",
                        condition: {
                          type: "Date",
                          date: "2020-01-01T00:00:00.000Z",
                        },
                      },
                    ],
                  },
                  {
                    id: "abort",
                    prefix: "abort/",
                    abortMultipartUploadsTransition: {
                      condition: { type: "Age", maxAge: 1 },
                    },
                  },
                ]
              : [],
          });
          return yield* Cloudflare.Worker("bucket-lifecycle-local", {
            main: Path.resolve(
              import.meta.dirname,
              "fixtures/bucket-lifecycle-worker.ts",
            ),
            env: { BUCKET: bucket, REVISION: String(active) },
          });
        });
      let worker = yield* stack.deploy(program(false));
      const invoke = (path: string) =>
        Effect.promise(async () => {
          const response = await fetch(`${worker.url}${path}`);
          if (!response.ok) throw new Error(await response.text());
          return response.json() as Promise<any>;
        });
      const seeded = yield* invoke("/seed");
      expect(seeded.defaultTier).toBe("InfrequentAccess");
      expect(seeded.multipartTier).toBe("InfrequentAccess");
      worker = yield* stack.deploy(program(true));
      yield* Effect.promise(async () =>
        (await fetch(`${worker.url}/revision`)).text(),
      ).pipe(
        Effect.flatMap((value) =>
          value === "true" ? Effect.void : Effect.fail(new RestartPending()),
        ),
        Effect.retry({ times: 8, schedule: Schedule.spaced("250 millis") }),
      );
      yield* Effect.sleep("1500 millis");
      const actual = yield* invoke("/");
      expect(actual.expired).toBeNull();
      expect(actual.archived.storageClass).toBe("InfrequentAccess");
      expect(actual.retained.storageClass).toBe("Standard");
      expect(actual.kept.storageClass).toBe("Standard");
      expect(
        actual.objects.find(
          (object: { key: string }) => object.key === "archive/a",
        ).storageClass,
      ).toBe("InfrequentAccess");
      expect(
        (yield* invoke(`/part?id=${encodeURIComponent(seeded.uploadId)}`))
          .accepted,
      ).toBe(false);
      worker = yield* stack.deploy(program(false));
      yield* Effect.promise(async () =>
        (await fetch(`${worker.url}/revision`)).text(),
      ).pipe(
        Effect.flatMap((value) =>
          value === "false" ? Effect.void : Effect.fail(new RestartPending()),
        ),
        Effect.retry({ times: 8, schedule: Schedule.spaced("250 millis") }),
      );
      yield* invoke("/put");
      expect(
        (yield* invoke("/")).objects.some(
          (object: { key: string }) => object.key === "expire/new",
        ),
      ).toBe(true);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
