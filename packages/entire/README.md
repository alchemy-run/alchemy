# @alchemy.run/entire

[Entire](https://entire.com) for [Alchemy](https://alchemy.run). Declare projects, repositories, review agents, and CI identities on the Git forge for agent-human collaboration.

```sh
npm install alchemy @alchemy.run/entire effect
```

A project with a protected repository and a review agent:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Entire from "@alchemy.run/entire";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "Forge",
  {
    providers: Entire.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const project = yield* Entire.Project("app", {});
    const repo = yield* Entire.Repo("api", { projectId: project.id });

    yield* Entire.BranchProtection("protection", {
      repoId: repo.id,
      rules: [{ ref: "HEAD", serverSideMergeOnly: true }],
    });

    const sandbox = yield* Entire.Environment("sandbox", { projectId: project.id });

    yield* Entire.RepoSecret("anthropic", {
      repoId: repo.id,
      key: "api_key_anthropic",
      value: yield* Config.redacted("ANTHROPIC_API_KEY"),
    });

    yield* Entire.Agent("reviewer", {
      projectId: project.id,
      harness: "claude",
      instructions: "Review {{branch}} against {{base_branch}} for security issues.",
      environmentId: sandbox.id,
      repositoryIds: [repo.id],
      trigger: { when: "ready" },
      enabled: true,
    });

    return { repo: repo.path };
  }),
);
```

Run `alchemy profile edit --add Entire` to log in with Entire's device flow. In CI, set `ENTIRE_TOKEN`.

Docs: [alchemy.run/entire](https://alchemy.run/entire)
