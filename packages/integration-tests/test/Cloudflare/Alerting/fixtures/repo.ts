import * as GitHub from "@alchemy.run/github";

export const owner = "alchemy-run-test";
export const repository = "alchemy-pr-2519-notifications";

// Public and retained across runs: the gh token lacks delete_repo.
export const Repo = GitHub.Repository("Repo", {
  owner,
  name: repository,
  visibility: "public",
  description: "Retained deterministic fixture for alchemy PR #2519 (Cloudflare notifications)",
  autoInit: true,
});
