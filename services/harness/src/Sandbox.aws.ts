import * as AWS from "@alchemy.run/aws";
import { ClaudeProgram, TOOLCHAIN } from "./Sandbox.impl.ts";
import { Sandbox } from "./Sandbox.ts";

/**
 * Hosts {@link Sandbox} on AWS Lambda MicroVMs: one MicroVM per session, run
 * by its Durable Object. With egress, the internet is closed: the MicroVM
 * reaches only the gateway's routes.
 */
export default AWS.Lambda.MicrovmSandbox(
  Sandbox,
  {
    main: import.meta.url,
    runtime: "node",
    dockerfile: TOOLCHAIN,
    sizes: { large: "8 GB" },
  },
  ClaudeProgram,
);
