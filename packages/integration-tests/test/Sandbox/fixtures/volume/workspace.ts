import * as Sandbox from "@alchemy.run/sandbox";

/** A forkable disk in R2: every session is a head forked from the base. */
export class TestWorkspace extends Sandbox.Volume<TestWorkspace>()("TestWorkspace") {}
