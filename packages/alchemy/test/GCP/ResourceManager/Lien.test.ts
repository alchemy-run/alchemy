import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
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

const waitUntilGone = (name: string) =>
  resourcemanager.getLiens({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getLiens on a missing lien fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        resourcemanager.getLiens({
          name: "liens/999999999999",
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, replace, and delete a lien",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ResourceManager.Lien("Hold", {
            reason: "production API key",
          });
        }),
      );

      expect(created.name).toMatch(/^liens\//);
      expect(created.parent).toContain("projects/");
      expect(created.origin).toEqual("alchemy.effect");
      expect(created.reason).toEqual("production API key");
      expect(created.restrictions).toContain("resourcemanager.projects.delete");

      const fetched = yield* resourcemanager.getLiens({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.reason).toContain("alchemy-id=");
      expect(fetched.reason).toContain("production API key");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ResourceManager.Lien("Hold", {
            parent: created.parent,
            origin: created.origin,
            reason: "holds billing export",
            restrictions: created.restrictions,
          });
        }),
      );

      expect(replaced.name).not.toEqual(created.name);
      expect(replaced.reason).toEqual("holds billing export");
      expect(replaced.parent).toEqual(created.parent);

      const fetchedReplace = yield* resourcemanager.getLiens({
        name: replaced.name,
      });
      expect(fetchedReplace.reason).toContain("holds billing export");
      expect(fetchedReplace.reason).toContain("alchemy-id=");

      const oldGone = yield* waitUntilGone(created.name);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
