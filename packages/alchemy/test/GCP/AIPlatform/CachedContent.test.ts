import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

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

const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  !!(process.env.GCP_TEST_AIPLATFORM || process.env.GCP_TEST_VERTEX);

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const parent = `projects/${project}/locations/us-central1`;
const model = `${parent}/publishers/google/models/gemini-2.0-flash-001`;

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsCachedContents({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsCachedContents on a missing cache fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsCachedContents({
          name: `${parent}/cachedContents/alchemy-aiplatform-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* aiplatform
        .listProjectsLocationsCachedContents({
          parent,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["Forbidden"], () =>
            Effect.succeed({ cachedContents: [] as const }),
          ),
        );
      expect(Array.isArray(page.cachedContents ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete cached content",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.CachedContent("Style", {
            location: "us-central1",
            model,
            ttl: "3600s",
            displayName: "style-cache",
            contents: [
              {
                role: "user",
                parts: [{ text: "You are a terse assistant. ".repeat(200) }],
              },
            ],
          });
        }),
      );

      expect(created.name).toContain("/cachedContents/");
      expect(created.model).toContain("gemini");
      expect(created.displayName).toEqual("style-cache");

      const fetched = yield* aiplatform.getProjectsLocationsCachedContents({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.CachedContent("Style", {
            location: "us-central1",
            model,
            ttl: "7200s",
            displayName: "style-cache",
            contents: [
              {
                role: "user",
                parts: [{ text: "You are a terse assistant. ".repeat(200) }],
              },
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
