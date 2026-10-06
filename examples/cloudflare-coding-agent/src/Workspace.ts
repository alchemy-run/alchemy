import * as AI from "alchemy/AI";

/** The repository every agent works in, checked out into the image. */
export const Workspace = AI.Environment("Workspace", {
  source: AI.GitSource({ repo: "octocat/Hello-World" }),
});
