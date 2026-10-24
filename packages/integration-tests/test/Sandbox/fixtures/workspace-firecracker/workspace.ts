import * as Sandbox from "@alchemy.run/sandbox";

/** Sessions on EC2 hosts whose commands run in Firecracker microVMs. */
export class MicroVMWorkspace extends Sandbox.Workspace<MicroVMWorkspace>()("MicroVMWorkspace") {}
