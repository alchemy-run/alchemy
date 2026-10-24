import * as AWS from "@alchemy.run/aws";
import { MicroVMWorkspace } from "./workspace.ts";

/** One small spot host with nested virtualization: a microVM per command. */
export default AWS.Workspace(MicroVMWorkspace, {
  dockerfile: `FROM node:24-bookworm-slim
RUN mkdir -p /workspace && echo base > /workspace/motd`,
  path: "/workspace",
  size: 1024 * 1024 * 1024,
  isolation: "firecracker",
  hosts: { instanceType: "c8i.large", spot: true },
  idle: "1 minute",
  cidrBlock: "10.92.0.0/16",
});
