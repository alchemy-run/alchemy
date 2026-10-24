import * as Sandbox from "@alchemy.run/sandbox";

/** Sessions whose machines are Lambda MicroVMs. */
export class LambdaWorkspace extends Sandbox.Workspace<LambdaWorkspace>()("LambdaWorkspace") {}
