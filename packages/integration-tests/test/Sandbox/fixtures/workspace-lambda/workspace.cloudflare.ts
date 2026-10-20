import * as Cloudflare from "@alchemy.run/cloudflare";
import { LambdaWorkspace } from "./workspace.ts";

/** Sessions on Cloudflare, machines on Lambda MicroVMs. */
export default Cloudflare.Containers.Workspace(LambdaWorkspace, {
  size: "1 GB",
  dockerfile: "FROM node:22-bookworm-slim\nRUN mkdir -p /workspace && echo base > /workspace/motd",
  path: "/workspace",
  machine: {
    idle: "2 minutes",
    lambda: { memory: "2 GB", cpuConfigurations: [{ architecture: "ARM_64" }] },
  },
});
