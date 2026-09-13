import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as Effect from "effect/Effect";
import { WORKSPACE_TERM, workspaceName } from "./Keys.ts";

export default import.meta.url;

/**
 * A WORKSPACE — a machine with the repository checked out, ready to be
 * worked on. One Workspace-term session per workspace, keyed
 * `<thread>::ws-<name>` (Terms.ts): the session IS the resource.
 *
 * - Its key is its MACHINE key (`machineKey` maps it to itself), so
 *   deployed it owns one MicroVM — launched from the baked image on
 *   first touch, converged to the requested ref by `CheckoutsSandbox`,
 *   suspended by the idle policy, terminated when the thread removes
 *   the session (`{ machine: true }`). In dev it is one linked
 *   worktree under `.alchemy/workspaces/` (`CheckoutsWorkspace`).
 * - Its terminal door is `/terminal/Workspace/<key>` — the session DO's
 *   PTY bridge lands on the workspace's machine, rooted at its tree
 *   (`WorkspaceRouter` resolves the session's own workspace).
 * - The thread's agents reach INTO it through the router (`@<name>/…`
 *   paths, or as their default workspace) — the workspace session
 *   holds the resource; it does not do the work.
 *
 * It has no conversation: `provision`/`release` are API methods the
 * thread manager calls (`WorkspaceAgent.at(key)`), never model turns.
 */
export class WorkspaceAgent extends AI.Agent<WorkspaceAgent, WorkspaceApi>(
  import.meta,
)(WORKSPACE_TERM) {}

/** What `provision` answers — the tree as the UI and tools name it. */
export interface ProvisionedWorkspace {
  /** The workspace key (`t-x::ws-pr-7`) — session, machine, checkout. */
  readonly key: string;
  /** The thread-local name (`pr-7`) — how agents and paths address it. */
  readonly name: string;
  /** The branch the tree is on. */
  readonly branch: string;
  /** The tree's path relative to the machine's sandbox root. */
  readonly path: string;
}

export interface WorkspaceApi {
  /** Converge the workspace's tree onto `ref` of `remote` (or the
   *  repository's default state), creating machine and checkout on
   *  first touch. Idempotent; `fresh` re-derives from the remote. */
  readonly provision: (options: {
    readonly remote: string;
    readonly ref?: string;
    readonly fresh?: boolean;
  }) => Effect.Effect<ProvisionedWorkspace, string>;
  /** Drop the workspace's checkout. The machine itself goes with the
   *  session (`sessions.remove(…, { machine: true })` — the thread's
   *  teardown); dev worktrees are dropped here. Idempotent. */
  readonly release: () => Effect.Effect<void, string>;
}

export const WorkspaceAgentLive = WorkspaceAgent.make(
  Effect.gen(function* () {
    const checkouts = yield* Git.Checkouts;

    const provision = (options: {
      readonly remote: string;
      readonly ref?: string;
      readonly fresh?: boolean;
    }) =>
      Effect.gen(function* () {
        const thread = yield* AI.Thread;
        const key = thread.key;
        const name = workspaceName(key);
        if (name === undefined) {
          return yield* Effect.fail(
            `'${key}' is not a workspace key — workspaces are keyed <thread>::ws-<name>`,
          );
        }
        const tree = yield* checkouts
          .checkout({
            key,
            remote: { url: options.remote },
            ...(options.ref !== undefined ? { ref: options.ref } : {}),
            ...(options.fresh !== undefined ? { fresh: options.fresh } : {}),
          })
          .pipe(Effect.mapError((error) => error.message));
        return {
          key,
          name,
          branch: tree.branch,
          path: tree.path,
        } satisfies ProvisionedWorkspace;
      });

    const release = () =>
      Effect.gen(function* () {
        const thread = yield* AI.Thread;
        yield* checkouts
          .release(thread.key)
          .pipe(Effect.mapError((error) => error.message));
      });

    return {
      turn: AI.fragment`A WORKSPACE session — a machine and a checked-out
      tree, not a conversation. Its thread's agents work in it (their
      sandbox routes here) and its terminal opens onto it; there is
      nothing to say to it.`,
      provision,
      release,
    };
  }),
);
