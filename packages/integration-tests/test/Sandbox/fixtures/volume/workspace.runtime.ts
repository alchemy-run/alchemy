import * as Cloudflare from "@alchemy.run/cloudflare";
import { TestWorkspace } from "./workspace.ts";

/** 1 GB in R2; the base holds one file, from a two-line image. */
export default Cloudflare.R2.Volume(TestWorkspace, {
  size: "1 GB",
  base: {
    dockerfile: "FROM alpine:3.22\nRUN mkdir -p /workspace && echo base > /workspace/motd",
    path: "/workspace",
  },
});
