import * as Sandbox from "@alchemy.run/sandbox";

/** Sessions on EC2 hosts: commands run there, in containers. */
export class ServiceWorkspace extends Sandbox.Workspace<ServiceWorkspace>()("ServiceWorkspace", {
  lww: ["dist/**"],
}) {}
