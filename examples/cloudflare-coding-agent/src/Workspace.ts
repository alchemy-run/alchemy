import * as AI from "alchemy/AI";

/** The box every agent wakes up in: Node, git, and a checkout of the repo. */
export const Workspace = AI.Environment({
  base: "node:22-bookworm",
  source: AI.GitSource({ repo: "octocat/Hello-World" }),
  workdir: "/workspace",
});
