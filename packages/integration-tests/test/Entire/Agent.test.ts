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

      const app = (props: Pick<Entire.AgentProps, "instructions" | "enabled" | "trigger">) =>
        Effect.gen(function* () {
          const project = yield* Entire.Project("Project", {});
          const repo = yield* Entire.Repo("Repo", { projectId: project.id });
          const env = yield* Entire.Environment("Sandbox", { projectId: project.id });
          const agent = yield* Entire.Agent("Reviewer", {
            projectId: project.id,
            harness: "claude",
            environmentId: env.id,
            repositoryIds: [repo.id],
            ...props,
          });
          return { project, repo, agent };
        });

      const first = yield* stack.deploy(app({ instructions: "Review {{branch}} for bugs." }));
      expect(first.agent.version).toEqual(1);
      expect(first.agent.repositoryIds).toEqual([first.repo.id]);
      const read = (id: string) =>
        EntireSdk.agents.getProjectAgent({
          host: first.project.host,
          project: first.project.name,
          id,
        });
      expect((yield* read(first.agent.id)).is_enabled).toEqual(false);

      const second = yield* stack.deploy(
        app({
          instructions: "Review {{branch}} for security issues.",
          enabled: true,
          trigger: { branches: ["main"], when: "always" },
        }),
      );
      expect(second.agent.id).toEqual(first.agent.id);
      expect(second.agent.version).toEqual(2);
      const live = yield* read(first.agent.id);
      expect(live.instructions).toEqual("Review {{branch}} for security issues.");
      expect(live.is_enabled).toEqual(true);
      expect(live.triggers?.map((t) => ({ branches: t.branches, when: t.when }))).toEqual([
        { branches: ["main"], when: "always" },
      ]);

      yield* stack.destroy();
      expect((yield* read(first.agent.id).pipe(Effect.flip))._tag).toEqual("NotFound");
    }),
  opts,
);
