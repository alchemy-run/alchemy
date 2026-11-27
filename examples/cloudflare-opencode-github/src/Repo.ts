import * as GitHub from "@alchemy.run/github";

export const owner = "alchemy-run-test";
export const repository = "alchemy-example-opencode-issue-bot";

/** The repository the bot answers issues on. */
export const Repo = GitHub.Repository("Repo", {
  owner,
  name: repository,
  visibility: "public",
  description:
    "Issues here are answered by an OpenCode agent (alchemy example cloudflare-opencode-github)",
  autoInit: true,
});

/** Hidden in every comment the bot posts, so it never answers itself. */
export const MARKER = "<!-- issue-bot -->";
