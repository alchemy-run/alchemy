import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { ImageLayer } from "../Docker/ImageLayer.ts";
import {
  mountGitRepository,
  type MountedRepository,
  type MountGitOptions,
} from "../FS/GitMount.ts";
import type { Repository } from "./Repository.ts";

export interface MountRepositoryOptions extends MountGitOptions {
  /**
   * A GitHub token for git inside the container (`access: "read"` or
   * `"write"`), e.g. a fine-grained token scoped to this repository. Bound
   * into the container's environment, never baked into the image.
   *
   * The build-time checkout does not use it: it runs your local `git`, so
   * private repositories clone with the git credentials you already have
   * (e.g. `gh auth setup-git`).
   */
  readonly token?: Redacted.Redacted<string>;
}

/** The GitHub CLI, so agents can work with issues and pull requests. */
const ghCliLayer: ImageLayer = {
  id: "gh-cli",
  stage: "setup",
  instructions: [
    "RUN if command -v apt-get >/dev/null 2>&1; then \\",
    "    apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg && \\",
    "    mkdir -p -m 755 /etc/apt/keyrings && \\",
    "    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && \\",
    "    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \\",
    '    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \\',
    "    apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*; \\",
    "  elif command -v apk >/dev/null 2>&1; then apk add --no-cache github-cli; fi",
  ].join("\n"),
};

/**
 * Check out a GitHub repository at an absolute path in the container (or
 * other image host) it is yielded in.
 *
 * The checkout is baked into the image with its full `.git`, on the
 * requested `ref` as a local branch tracking `origin`, so agents use the git
 * CLI as usual. `access` decides what git may do inside the container:
 * `"none"` (a snapshot, push disabled), `"read"` (fetch and pull), or
 * `"write"` (also push) — the last two with the `token` you give, which
 * also installs the `gh` CLI signed in as that token (`GH_TOKEN`), so agents
 * can work with issues and pull requests. `submodules`, `install` and
 * `build` make the checkout ready to work in. The repository is prepared
 * once per commit on the deploying machine; the image gets the built tree
 * and reinstalls dependencies for its own platform.
 *
 * ### Mounting a repository
 * **Example:** A writable checkout for a coding agent
 * ```typescript
 * export const App = GitHub.Repository("app", { owner: "acme", name: "app" });
 *
 * export default Sandbox.make(
 *   { main: import.meta.url, runtime: "node", image: "node:22-bookworm" },
 *   Effect.gen(function* () {
 *     const app = yield* GitHub.MountRepository(yield* App, {
 *       path: "/workspace/app",
 *       ref: "main",
 *       access: "write",
 *       token: yield* Config.Redacted("GITHUB_AGENT_TOKEN"),
 *     });
 *     const claude = yield* Anthropic.ClaudeCodeServer("Claude", { cwd: app.path });
 *     return { fetch: yield* AI.serveHarnessHttp(claude) };
 *   }),
 * );
 * ```
 *
 * **Example:** A monorepo, installed and built, with `gh`
 * ```typescript
 * yield* GitHub.MountRepository("alchemy-run/alchemy", {
 *   path: "/workspace/alchemy",
 *   submodules: ["submodules/distilled"],
 *   install: "pnpm install --frozen-lockfile",
 *   build: "pnpm exec tsc -b",
 *   access: "write",
 *   token: yield* Config.Redacted("GITHUB_TOKEN"),
 * });
 * ```
 *
 * **Example:** A read-only snapshot of a public repository
 * ```typescript
 * yield* GitHub.MountRepository("octocat/Hello-World", { path: "/workspace/hello" });
 * ```
 *
 * @binding
 * @product Repository
 * @category GitHub
 */
export const MountRepository = (
  repository: Repository | string,
  options: MountRepositoryOptions,
): Effect.Effect<MountedRepository> =>
  mountGitRepository({
    kind: "GitHub.MountRepository",
    ...(typeof repository === "string"
      ? { url: `https://github.com/${repository}.git` }
      : {
          resource: repository,
          url: repository.cloneUrl,
        }),
    ...(options.token
      ? {
          runtimeCredentials: { username: "x-access-token", password: options.token },
          // A GitHub checkout with a token also gets the `gh` CLI, signed in.
          tooling: [ghCliLayer],
          env: { GH_TOKEN: options.token },
        }
      : {}),
    mount: options,
  });
