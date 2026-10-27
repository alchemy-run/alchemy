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
  "create, replace a version, archive",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = (props: Omit<Entire.EnvironmentProps, "projectId">) =>
        Effect.gen(function* () {
          const project = yield* Entire.Project("Project", {});
          const env = yield* Entire.Environment("Sandbox", { projectId: project.id, ...props });
          return { project, env };
        });

      const first = yield* stack.deploy(app({ description: "v1", autoStopMinutes: 15 }));
      expect(first.env.version).toEqual(1);
      const read = (id: string) =>
        EntireSdk.environments.getProjectEnvironment({
          host: first.project.host,
          project: first.project.name,
          id,
        });
      expect((yield* read(first.env.id)).auto_stop_minutes).toEqual(15);

      // Unchanged props save no new version.
      const same = yield* stack.deploy(app({ description: "v1", autoStopMinutes: 15 }));
      expect(same.env.version).toEqual(1);

      const second = yield* stack.deploy(app({ description: "v2", autoStopMinutes: 30 }));
      expect(second.env.id).toEqual(first.env.id);
      expect(second.env.version).toEqual(2);
      expect((yield* read(first.env.id)).description).toEqual("v2");

      yield* stack.deploy(Entire.Project("Project", {}));
      expect((yield* read(first.env.id)).archived_at).not.toBeNull();

      yield* stack.destroy();
    }),
  opts,
);
