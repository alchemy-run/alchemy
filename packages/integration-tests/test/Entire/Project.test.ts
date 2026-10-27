import * as Entire from "@alchemy.run/entire";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as EntireSdk from "@distilled.cloud/entire";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Entire.providers() });

// Entire caps an account's projects and org creations, and a burst of
// parallel creates leaves projects whose owner grant never lands, so the
// Entire suites take turns.
const opts = { tags: ["provider:entire", "live"], timeout: 180_000, exclusive: "entire:account" };

test.provider(
  "create, replace on rename, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Entire.Project("Project", {});
        }),
      );
      const observed = yield* EntireSdk.projects.getProject({ projectId: first.id });
      expect(observed.name).toEqual(first.name);
      expect(observed.ownerType).toEqual("account");
      expect(first.host).toEqual("et");
      expect(first.apiUrl).toBeDefined();

      // Redeploying the same props changes nothing.
      const again = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Entire.Project("Project", {});
        }),
      );
      expect(again.id).toEqual(first.id);

      // A new name is a new project; the old one is deleted.
      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Entire.Project("Project", { name: `${first.name.slice(0, 29)}-r2` });
        }),
      );
      expect(renamed.id).not.toEqual(first.id);
      const oldGone = yield* EntireSdk.projects
        .getProject({ projectId: first.id })
        .pipe(Effect.flip);
      expect(oldGone._tag).toEqual("NotFound");

      yield* stack.destroy();
      const gone = yield* EntireSdk.projects
        .getProject({ projectId: renamed.id })
        .pipe(Effect.flip);
      expect(gone._tag).toEqual("NotFound");
    }),
  opts,
);
