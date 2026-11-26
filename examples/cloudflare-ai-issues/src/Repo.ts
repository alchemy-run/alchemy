import * as GitHub from "@alchemy.run/github";

export const owner = "alchemy-run-test";
export const repository = "alchemy-example-ai-issues";

/** The repository whose issues the board tracks. */
export const Repo = GitHub.Repository("Repo", {
  owner,
  name: repository,
  visibility: "public",
  description: "Issues here are triaged by an AI process (alchemy example cloudflare-ai-issues)",
  autoInit: true,
});
