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
  ## Sandboxes and checkouts

  A session's key names its tree: \`owner/repo/name\` works in the
  repository's default branch; \`owner/repo#N\` works in pull request
  N's head, checked out ON that branch (a fork's head is read-only at
  \`pull/N/head\`). \`github/SessionRepo.ts\` resolves which tree a key
  means; the checkout itself lands the first time a tool touches the
  machine (\`sandbox/SandboxCheckout.ts\`) — a reply that needs no tool
  needs no machine, and the wait shows on the tool that does.

  \`sandbox/SandboxSession.ts\` picks a session's machine; the variants
  keep the prefix — \`SandboxMicrovm.ts\`, \`SandboxContainer.ts\`,
  \`SandboxWorktree.ts\` — and \`CheckoutsSandbox.ts\` /
  \`CheckoutsWorktree.ts\` implement \`Git.Checkouts\` over each. A new
  place code can run is a new \`Sandbox*\` file, never a branch inside
  an existing one.

  Under \`alchemy dev\` the machine is a git worktree under
  \`.alchemy/worktrees\`, created by \`scripts/worktree.ts\`, and
  distilled is a worktree of the SHARED submodule repository
  (\`.git/modules/distilled\`) — never run \`git submodule update\`
  inside a linked worktree: it repoints the shared module's
  \`core.worktree\` and breaks the root checkout. Deployed, the machine
  is a microVM booted from the image \`sandbox/SandboxBake.ts\` bakes
  with the repository installed and compiled; a change to what the
  image must contain is a change there.

  A terminal opened on a session (\`SandboxPty\`) lands in the same tree
  the tools use, on the same branch — the operator sees what the agent
  sees. What a tool prints is not the sandbox's concern: output
  bounding and the spill net live in \`artifacts/\`, and the sandbox is
  merely one physics of that store (\`artifacts/ArtifactsSandbox.ts\`).`;
