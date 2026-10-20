import * as Cloudflare from "@alchemy.run/cloudflare";
import { INSTANCE } from "./Machine.ts";
import { ClaudeProgram, TOOLCHAIN } from "./Sandbox.impl.ts";
import { Sandbox } from "./Sandbox.ts";

/**
 * Hosts {@link Sandbox} on Cloudflare Containers: one container per session,
 * scheduled by its Durable Object, which snapshots and restores it.
 */
export default Cloudflare.Containers.Sandbox(
  Sandbox,
  {
    main: import.meta.url,
    runtime: "node",
    dockerfile: { content: TOOLCHAIN },
    sizes: { large: INSTANCE },
  },
  ClaudeProgram,
);
