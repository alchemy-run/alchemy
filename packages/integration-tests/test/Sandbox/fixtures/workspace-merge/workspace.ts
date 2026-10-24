import * as Sandbox from "@alchemy.run/sandbox";

/** Sessions whose commands fork, run anywhere, and merge back. Build output's newest change wins. */
export class MergeWorkspace extends Sandbox.Workspace<MergeWorkspace>()("MergeWorkspace", {
  lww: ["dist/**"],
}) {}
