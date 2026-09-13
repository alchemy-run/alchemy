import * as AI from "alchemy/AI";

/**
 * Where a session's code RUNS — machines, trees, checkouts. Activated
 * when a change touches `sandbox/`: which machine a session gets, how
 * its tree lands, what survives a restart.
 */
export class SandboxGuidance extends AI.Skill<SandboxGuidance>(import.meta)(
  "SandboxGuidance",
) {}

export const SandboxGuidanceGeneral = SandboxGuidance.make`
  ## Sandboxes, workspaces, checkouts

  Sessions work in WORKSPACES — each an isolated machine with the
  repository checked out, owned by a thread and shared by ALL of that
  thread's agents. \`sandbox/WorkspaceRouter.ts\` is every session's
  \`AI.Sandbox\`: a path's \`@<name>/\` prefix (or the session's
  default workspace, \`sandbox/SessionTree.ts\`) picks the workspace,
  and the call lands on ITS machine — there is NO machine root to fall
  back to; a session whose workspace cannot resolve gets a typed error
  (an engineer once ran git in the developer's own checkout; the
  router exists so that cannot recur). A standalone coder session
  (\`owner/repo/name\`, \`owner/repo#N\` — \`github/SessionRepo.ts\`
  resolves the key) has one implicit workspace, converged on first
  touch — a reply that needs no tool needs no machine, and the wait
  shows on the tool that does.

  \`sandbox/WorkspaceAgent.ts\` is the workspace as a SESSION
  (\`root::ws-<name>\`, \`sandbox/Keys.ts\`): its key is its
  machine key, its methods provision and release the checkout, its
  \`/terminal/Workspace/<key>\` socket is the workspace's terminal.
  \`sandbox/SandboxSession.ts\` picks the physics; the variants keep
  the prefix — \`SandboxMicrovm.ts\`, \`SandboxContainer.ts\`,
  \`SandboxDev.ts\` — and \`CheckoutsSandbox.ts\` /
  \`CheckoutsWorkspace.ts\` implement \`Git.Checkouts\` over each. A
  new place code can run is a new \`Sandbox*\` file, never a branch
  inside an existing one.

  Under \`alchemy dev\` a workspace is a git worktree under
  \`.alchemy/workspaces\`, provisioned by \`sandbox/WorkspaceHost.ts\`
  INSIDE the dev server process (\`scripts/sandbox-dev.ts\` serves the
  workspaces directory as the sandbox root — sessions cannot address
  the developer's checkout), and distilled is a worktree of the SHARED
  submodule repository (\`.git/modules/distilled\`) — never run
  \`git submodule update\` inside a linked worktree: it repoints the
  shared module's \`core.worktree\` and breaks the root checkout.
  Deployed, a workspace is its OWN microVM booted from the image
  \`sandbox/SandboxBake.ts\` bakes with the repository installed and
  compiled; a change to what the image must contain is a change there.

  A terminal opened on a session (\`SandboxPty\`) lands in the same tree
  the tools use, on the same branch — the operator sees what the agent
  sees. What a tool prints is not the sandbox's concern: output
  bounding and the spill net live in \`artifacts/\`, and the sandbox is
  merely one physics of that store (\`artifacts/ArtifactsSandbox.ts\`).`;
