import * as GitHub from "@alchemy.run/github";

export const owner = "alchemy-run-test";
export const repository = "alchemy-example-pi-issue-bot";

/** The repository the bot answers issues on. */
export const Repo = GitHub.Repository("Repo", {
  owner,
  name: repository,
  visibility: "public",
  description: "Issues here are answered by a Pi agent (alchemy example cloudflare-pi-github)",
  autoInit: true,
});
