/** `AWS.Lambda.MicrovmImage` bootstrap on the bun runtime. */
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "../../Http.ts";
import { bootstrapMicrovm, type MicrovmBootstrapOptions } from "./Microvm.ts";

export const bootstrap = (
  entrypoint: unknown,
  options: MicrovmBootstrapOptions,
): Promise<void> =>
  bootstrapMicrovm(
    {
      services: BunServices.layer,
      // idle reaping OFF: the guest serves long-lived streaming
      // responses (the sandbox PTY between keystrokes) that Bun's
      // 10-second default would kill mid-session
      httpServer: BunHttpServer({ idleTimeout: 0 }),
    },
    entrypoint,
    options,
  );
