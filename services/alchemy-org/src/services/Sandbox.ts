/**
 * The org's SANDBOX — the factory's keyboard on Cloudflare: a
 * Container (a real Linux machine with git, ripgrep, and a Bun Effect
 * runtime) that hosts the repository checkouts and answers the coding
 * tools. The SAME physics as the local process — the container's
 * program builds `tools/LocalToolbox.ts` and `Git.WorkspacesWorktree`
 * verbatim — reached over the container's typed RPC instead of
 * in-process calls.
 *
 * The class is the tag + typed shape ONLY (this file is bundled into
 * Workers and Durable Objects); the runtime lives in
 * `Sandbox.runtime.ts`, which alchemy bundles into the container
 * image.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import type * as Effect from "effect/Effect";

/** One toolbox invocation, addressed to a run's worktree by KEY. */
export interface SandboxCall {
  /** The tool's name — the same name its `AI.Tool` tag declares. */
  readonly tool: string;
  /** The run key — `Git.Workspaces` memoizes checkout by it, so the
   *  engineer and reviewer of one issue land in one worktree. */
  readonly key: string;
  readonly params: unknown;
}

/** Commit-and-push a run's worktree (the git half of OpenPullRequest —
 *  the GitHub API half stays on the Worker). */
export interface SandboxPush {
  readonly key: string;
  readonly branch: string;
  readonly message: string;
}

export class OrgSandbox extends Cloudflare.Container<
  OrgSandbox,
  {
    readonly call: (
      input: SandboxCall,
    ) => Effect.Effect<unknown, string>;
    readonly push: (
      input: SandboxPush,
    ) => Effect.Effect<{ readonly branch: string }, string>;
  }
>()("OrgSandbox") {}
