import * as PersistentRef from "alchemy/PersistentRef";

/**
 * WHICH EXISTING TREE a session works in, when it is not its own — the
 * key of a `Git.Checkouts` checkout SOMEONE ELSE made on the session's
 * machine. A thread's engineer is the case: the thread ensures one
 * worktree per pull request it governs and hands each engineer the
 * key of the one its brief is about (`Engineer.setTree`, before the
 * brief); `SandboxCheckout` then roots EVERY call of that session —
 * its shell, its file tools, its terminal — in that tree, so the
 * engineer cannot wander into the developer's own checkout or a
 * sibling's worktree by running `git checkout` at "the root".
 *
 * A declared cell (plan-time, no store): every read resolves the
 * ambient `PersistentRef.Store` of the frame that runs it — the
 * calling session's own row. `null` is the default: the session's
 * tree is whatever `SessionRepo` derives from its key.
 */
export const assignedTree = PersistentRef.of<string | null>("tree", () => null);
