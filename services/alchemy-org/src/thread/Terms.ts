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
