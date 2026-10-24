import * as Sandbox from "@alchemy.run/sandbox";

/** Forkable sessions: each a disk, mounted while an `open` runs. */
export class TestWorkspace extends Sandbox.Workspace<TestWorkspace>()("TestWorkspace") {}
