import * as AWS from "@alchemy.run/aws";
import { ServiceWorkspace } from "./workspace.ts";

/** The smallest Graviton spot hosts: two, so requests are forwarded between them. */
export default AWS.Workspace(ServiceWorkspace, {
  dockerfile: `FROM node:24-bookworm-slim
RUN mkdir -p /workspace && echo base > /workspace/motd`,
  path: "/workspace",
  size: 1024 * 1024 * 1024,
  isolation: "container",
  placement: "automatic",
  hosts: { instanceType: "t4g.small", spot: true, min: 2, max: 2 },
  idle: "1 minute",
  cidrBlock: "10.91.0.0/16",
});
