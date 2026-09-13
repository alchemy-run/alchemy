import * as PersistentRef from "alchemy/PersistentRef";

/**
 * WHICH WORKSPACE a session works in by default — the thread-local
 * name (`pr-7`) of a {@link WorkspaceAgent} workspace on the session's
 * thread. A thread's engineer is the case: the thread provisions one
 * workspace per pull request it governs and hands each engineer the
 * one its brief is about (before the brief); `WorkspaceRouter` then
 * roots every unprefixed call of that session — its shell, its file
 * tools, its terminal — in that workspace's tree, so the engineer
 * cannot wander into the developer's own checkout or a sibling's
 * workspace by running `git checkout` at "the root".
 *
 * A declared cell (plan-time, no store): every read resolves the
 * ambient `PersistentRef.Store` of the frame that runs it — the
 * calling session's own row. `null` is the default: the session has
 * no workspace until it is handed one (`@<name>/…` paths still reach
 * any of the thread's workspaces through the router).
 */
export const defaultWorkspace = PersistentRef.of<string | null>(
  "workspace",
  () => null,
);
