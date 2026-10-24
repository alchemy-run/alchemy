import * as Cloudflare from "@alchemy.run/cloudflare";
import { TestWorkspace } from "./workspace.ts";

/** 1 GB sessions whose base is /workspace of a small Node image. */
export default Cloudflare.Containers.Workspace(TestWorkspace, {
  size: "1 GB",
  dockerfile: "FROM node:22-bookworm-slim\nRUN mkdir -p /workspace && echo base > /workspace/motd",
  path: "/workspace",
  machine: { instanceType: "standard-1", idle: "2 minutes" },
});
