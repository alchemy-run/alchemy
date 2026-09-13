import { ROOT } from "../Root.ts";

/**
 * WORKSPACE and MACHINE keys — the sandbox's slice of the lineage.
 *
 * A workspace's key is its `Git.Checkouts` key AND its Workspace-term
 * session key: `root::ws-<name>`. The name is the thread-local handle
 * agents and the UI use (`pr-1521`, `scratch`); the key is DERIVABLE
 * from the root plus the name, so addressing a workspace never needs
 * shared state.
 */

/** The workspaces' session term (`WorkspaceAgent`): one session per
 *  WORKSPACE — the machine-owning resource the company works in. */
export const WORKSPACE_TERM = "Workspace";

/** A workspace's key: `workspaceKey("root", "pr-7")` → `root::ws-pr-7`. */
export const workspaceKey = (root: string, name: string): string =>
  `${root}::ws-${name}`;

/** The thread-local name of a workspace key (`root::ws-pr-7` → `pr-7`);
 *  undefined for keys that are not workspace keys. */
export const workspaceName = (key: string): string | undefined => {
  const at = key.indexOf("::ws-");
  return at >= 0 ? key.slice(at + "::ws-".length) : undefined;
};

/** The conventional workspace name for a pull request. */
export const pullWorkspaceName = (number: number): string => `pr-${number}`;

/**
 * The MACHINE a session key addresses. A workspace key (or any session
 * key inside one — `root::ws-pr-7::…`) owns its own machine; every
 * other key shares its root session's. Deployed this keys the MicroVM
 * (one VM per workspace); in dev it only scopes PTY ids on the one
 * host server.
 */
export const machineKey = (sessionKey: string): string => {
  const segments = sessionKey.split("::");
  return segments.length >= 2 && segments[1]!.startsWith("ws-")
    ? `${segments[0]}::${segments[1]}`
    : segments[0]!;
};

/** Every workspace of the root — for tools that list or default. */
export const rootWorkspaceKey = (name: string): string =>
  workspaceKey(ROOT, name);
