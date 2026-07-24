import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { Remote } from "./Remote.ts";

/** A git operation failed — the command, its exit, and its stderr. */
export class GitError extends Data.TaggedError("Git.GitError")<{
  readonly command: string;
  readonly exitCode: number;
  readonly stderr: string;
}> {
  override get message(): string {
    return `git ${this.command} exited ${this.exitCode}: ${this.stderr}`;
  }
}

/** A working tree, addressed by its key. */
export interface Workspace {
  /** The address — what crosses agent boundaries. */
  readonly key: string;
  /** Absolute path of the working tree (dir, volume, or FUSE mount). */
  readonly root: string;
  /**
   * The tree's path RELATIVE to the Layer's workspaces root — what a
   * sandboxed toolbox rooted at the workspaces root resolves against.
   */
  readonly path: string;
  /** The branch this tree has checked out. */
  readonly branch: string;
  /** The remote this tree tracks. */
  readonly remote: Remote;
}

export interface WorkspacesService {
  /**
   * Acquire the working tree for `key` — IDEMPOTENT: the same key
   * returns the same tree. `fresh: true` discards any existing tree
   * and re-derives from the remote.
   */
  readonly checkout: (options: {
    readonly key: string;
    readonly remote: Remote;
    /** Branch or commit to base the tree on. @default the remote's default branch */
    readonly ref?: string;
    readonly fresh?: boolean;
  }) => Effect.Effect<Workspace, GitError>;
  /** Address an existing tree by key. */
  readonly get: (key: string) => Effect.Effect<Option.Option<Workspace>>;
  /** Drop the tree — a settled run's cleanup. Idempotent. */
  readonly release: (key: string) => Effect.Effect<void, GitError>;
}

/**
 * A git repository CHECKED OUT somewhere an agent can work — as a
 * capability. One contract; the PHYSICS of "somewhere" is the Layer:
 *
 * - {@link WorkspacesWorktree} (local): one central blobless clone per
 *   remote, `git worktree add` per key — cheap per-run trees, shared
 *   object store.
 * - `WorkspacesClone` (local): a clean clone per key, when isolation
 *   beats speed.
 * - `WorkspacesArtifacts` (Cloudflare containers): per-key FORKS in a
 *   `Cloudflare.Artifacts` namespace, mounted via artifact-fs with
 *   blobs hydrating on demand; its deploy-time half contributes the
 *   image statements (install artifact-fs, fuse3) to the host
 *   Container through the binding contract.
 *
 * `checkout` is IDEMPOTENT BY KEY: the key is the ADDRESS — a run that
 * acquires `repo#7` and a tool handler that resolves the same key get
 * the same tree, and a process dispatching work can hand the key to
 * another agent. The artifact that crosses machine boundaries is the
 * pushed branch, never a shared filesystem.
 *
 * In a charter, acquisition belongs in INIT — init runs once per run
 * with `AI.Thread` in scope, so the checkout is thread-scoped setup
 * the turn and tool handlers close over:
 *
 * ```ts
 * const workspaces = yield* Git.Workspaces;              // init: the binding
 * const { key } = yield* AI.Thread;                      // init is per-run
 * const ws = yield* workspaces.checkout({ key, remote });
 * return Effect.gen(function* () {
 *   return yield* AI.prose`…your checkout is ${ws.path}, branch ${ws.branch}…`;
 * });
 * ```
 */
export class Workspaces extends Context.Service<
  Workspaces,
  WorkspacesService
>()("alchemy/Git/Workspaces") {}
