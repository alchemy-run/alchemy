/**
 * The thread's session terms and key shapes — a leaf module both sides
 * of the thread (the manager's charter, the engineer's, the facade, the
 * message tool) import without importing each other.
 */

/** The thread agent's — the MANAGER's — session term. */
export const THREAD_TERM = "Thread";

/** The engineers' session term (`Engineer["~alchemy/Name"]`). */
export const ENGINEER_TERM = "Engineer";

/**
 * The thread that kicked off a subagent session, from its key: an
 * engineer a thread spawned is keyed `<thread>::e-<id>`
 * (ThreadAgent.spawn). A standalone session (`owner/repo/name`)
 * belongs to none.
 */
export const threadOf = (sessionKey: string): string | undefined => {
  const at = sessionKey.indexOf("::");
  return at >= 0 ? sessionKey.slice(0, at) : undefined;
};

/** How agents of one thread name each other: the manager is
 *  "manager"; an engineer is the tail of its key (`e-1bcde71c`). */
export const MANAGER = "manager";

/** An engineer's short name within its thread — the key's tail. */
export const shortName = (engineerKey: string): string => {
  const at = engineerKey.indexOf("::");
  return at >= 0 ? engineerKey.slice(at + 2) : engineerKey;
};

/** The full engineer key for a short name (or a full key) within a
 *  thread. */
export const engineerKey = (threadId: string, name: string): string =>
  name.includes("::") ? name : `${threadId}::${name}`;

/* ── workspaces ─────────────────────────────────────────────────── */

/** The workspace sessions' term — the session IS the resource: one
 *  machine with one checkout, keyed by the thread and a local name. */
export const WORKSPACE_TERM = "Workspace";

/** A workspace's session key within its thread: `t-x::ws-pr-7`. */
export const workspaceKey = (threadId: string, name: string): string =>
  `${threadId}::ws-${name}`;

/** The canonical workspace name for a pull request: `pr-<number>`. */
export const pullWorkspaceName = (number: number): string => `pr-${number}`;

/** The thread-local workspace name from a session key
 *  (`t-x::ws-pr-7` → `pr-7`); `undefined` for any other key. */
export const workspaceName = (sessionKey: string): string | undefined => {
  const at = sessionKey.indexOf("::ws-");
  if (at < 0) return undefined;
  const name = sessionKey.slice(at + 5);
  return name.includes("::") ? undefined : name;
};

/** The MACHINE a session's sandbox calls land on: a workspace session
 *  owns its machine (its own key), and any deeper key inside a
 *  workspace addresses that workspace's; everything else (standalone
 *  coder sessions) is its own machine. A thread's agents own no
 *  machine — their calls are routed per workspace (WorkspaceRouter)
 *  before this mapping applies. */
export const machineKey = (sessionKey: string): string => {
  const at = sessionKey.indexOf("::ws-");
  if (at < 0) return sessionKey;
  const rest = sessionKey.indexOf("::", at + 5);
  return rest < 0 ? sessionKey : sessionKey.slice(0, rest);
};
