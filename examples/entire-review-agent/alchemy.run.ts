import * as Entire from "@alchemy.run/entire";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "EntireReviewAgent",
  {
    providers: Entire.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const project = yield* Entire.Project("Project", {});
    const repo = yield* Entire.Repo("Api", { projectId: project.id, name: "api" });

    // The default branch moves only through Entire's server-side merge.
    yield* Entire.BranchProtection("Protection", {
      repoId: repo.id,
      rules: [{ ref: "HEAD", serverSideMergeOnly: true }],
    });

    yield* Entire.RepoSettings("Settings", {
      repoId: repo.id,
      trailsEnabled: true,
      runnersEnabled: true,
      autoRunOnPush: true,
    });

    const sandbox = yield* Entire.Environment("Sandbox", {
      projectId: project.id,
      description: "Sandbox for review runs",
      autoStopMinutes: 30,
    });

    const reviewer = yield* Entire.Agent("Reviewer", {
      projectId: project.id,
      harness: "claude",
      instructions:
        "Review the changes on {{branch}} against {{base_branch}}. Report bugs, " +
        "regressions and missing tests, each with the file and line.",
      environmentId: sandbox.id,
      repositoryIds: [repo.id],
      trigger: { when: "ready" },
      enabled: true,
    });

    return {
      projectId: project.id,
      projectName: project.name,
      repoId: repo.id,
      repoPath: repo.path,
      reviewerId: reviewer.id,
    };
  }),
);
