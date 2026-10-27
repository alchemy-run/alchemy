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
  "write declared settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = (props: Omit<Entire.RepoSettingsProps, "repoId">) =>
        Effect.gen(function* () {
          const project = yield* Entire.Project("Project", {});
          const repo = yield* Entire.Repo("Repo", { projectId: project.id });
          return yield* Entire.RepoSettings("Settings", { repoId: repo.id, ...props });
        });

      const first = yield* stack.deploy(
        app({ trailsEnabled: false, runnersEnabled: true, autoRunOnPush: true }),
      );
      expect(first).toMatchObject({
        trailsEnabled: false,
        runnersEnabled: true,
        autoRunOnPush: true,
      });

      const second = yield* stack.deploy(app({ trailsEnabled: true, publicSharingEnabled: true }));
      expect(second).toMatchObject({
        trailsEnabled: true,
        runnersEnabled: true,
        autoRunOnPush: true,
        publicSharingEnabled: true,
      });
      // Out of band: the repository's cell reports the stored settings, and
      // the runner settings (not declared in the second deploy) kept their
      // values.
      const meta = yield* EntireSdk.repoDetails.getRepoMeta({ repo_id: second.repoId });
      expect(meta).toMatchObject({
        trails_enabled: true,
        runners_enabled: true,
        auto_run_on_push: true,
        public_sharing_enabled: true,
      });

      yield* stack.destroy();
    }),
  opts,
);
