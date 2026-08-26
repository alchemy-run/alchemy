import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_CONTENTWAREHOUSE;

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const location = "us";
const parent = `projects/${project}/locations/${location}`;

const waitUntilGone = (name: string) =>
  cw.getProjectsLocationsSynonymSets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsSynonymSets on a missing synonym set fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cw.getProjectsLocationsSynonymSets({
          name: `${parent}/synonymSets/alchemy-missing-synonyms`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a synonym set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* cw
        .listProjectsLocationsSynonymSets({
          parent,
          pageSize: 1,
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", (error) =>
            Effect.succeed({
              tag: "Forbidden" as const,
              message: error.message,
            }),
          ),
          Effect.catchTag("NotFound", (error) =>
            Effect.succeed({
              tag: "NotFound" as const,
              message: error.message,
            }),
          ),
        );
      if (probe.tag !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(probe.tag);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Contentwarehouse.SynonymSet("Sales", {
            location,
            synonyms: [{ words: ["sale", "invoice", "bill"] }],
          });
        }),
      );

      expect(created.context).toEqual(expect.any(String));
      expect(created.name).toContain("/synonymSets/");
      expect(
        (created.synonyms ?? []).some((group) =>
          (group.words ?? []).includes("invoice"),
        ),
      ).toEqual(true);

      const fetched = yield* cw.getProjectsLocationsSynonymSets({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(
        (fetched.synonyms ?? []).some((group) =>
          (group.words ?? []).some(
            (word) => word.startsWith("[alc ") || word.startsWith("[alchemy "),
          ),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Contentwarehouse.SynonymSet("Sales", {
            context: created.context,
            location,
            synonyms: [
              { words: ["sale", "invoice", "bill", "order"] },
              { words: ["money", "credit"] },
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(
        (updated.synonyms ?? []).some((group) =>
          (group.words ?? []).includes("order"),
        ),
      ).toEqual(true);
      expect(
        (updated.synonyms ?? []).some((group) =>
          (group.words ?? []).includes("credit"),
        ),
      ).toEqual(true);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
