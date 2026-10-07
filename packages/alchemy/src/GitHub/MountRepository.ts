import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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

/**
 * Check out a GitHub repository at an absolute path in the container (or
 * other image host) it is yielded in.
 *
 * The checkout is baked into the image with its full `.git`, on the
 * requested `ref` as a local branch tracking `origin`, so agents use the git
 * CLI as usual. `access` decides what git may do inside the container:
 * `"none"` (a snapshot, push disabled), `"read"` (fetch and pull), or
 * `"write"` (also push) — the last two with the `token` you give.
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
      ? { runtimeCredentials: { username: "x-access-token", password: options.token } }
      : {}),
    mount: options,
  });
