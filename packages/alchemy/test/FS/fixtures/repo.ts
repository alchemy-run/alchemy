import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Cloudflare from "@/Cloudflare";
import * as Git from "@/Git/index.ts";
import * as GitHub from "@/GitHub/index.ts";
import TestGitHost, { TEST_SECRET, TEST_USER } from "../../Git/fixtures/stack.ts";

/** The suite middleware's HTTP Basic credential. */
export const GIT_CREDENTIALS: Git.RepositoryCredentials = { password: Redacted.make(TEST_SECRET) };

/** A repository on the local Git service, imported from GitHub. */
export const DocsRepo = Effect.gen(function* () {
  const host = yield* TestGitHost;
  return yield* Git.Repository("MountDocs", {
    url: host.url.as<string>(),
    owner: TEST_USER.id,
    import: { url: "https://github.com/octocat/Hello-World.git" },
    credentials: GIT_CREDENTIALS,
  });
});

/**
 * A private GitHub repository in the test organization (which allows
 * deploy keys), mounted without a token: the mount creates a deploy key.
 */
export const AgentRepo = GitHub.Repository("MountAgentRepo", {
  owner: process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test",
  name: "test-mount-deploy-key",
  visibility: "private",
  autoInit: true,
});

/** A Cloudflare Artifacts repository, imported from GitHub. */
export const ScratchRepo = Cloudflare.Artifacts.Repository("MountScratch", {
  namespace: "alchemy-tests",
  import: { url: "https://github.com/octocat/Hello-World.git" },
});
