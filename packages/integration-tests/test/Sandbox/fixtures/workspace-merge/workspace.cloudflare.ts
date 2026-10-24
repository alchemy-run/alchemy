import * as Cloudflare from "@alchemy.run/cloudflare";
import { MergeWorkspace } from "./workspace.ts";

/** btrfs sessions on Cloudflare containers; every `exec` on a fork, kept while it leaves processes running. */
export default Cloudflare.Containers.Workspace(MergeWorkspace, {
  size: "1 GB",
  filesystem: "btrfs",
  dockerfile:
    "FROM node:22-bookworm-slim\nRUN mkdir -p /workspace/src && echo base > /workspace/motd && echo shared > /workspace/src/shared.txt",
  path: "/workspace",
  machine: {
    instanceType: "standard-1",
    idle: "2 minutes",
    placement: "automatic",
    pool: { max: 6 },
  },
});
