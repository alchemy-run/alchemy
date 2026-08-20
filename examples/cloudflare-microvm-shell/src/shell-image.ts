import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";

/**
 * The shell MicroVM image, built from `../context/` (a Dockerfile that installs
 * bun and runs `server.js`). External (Dockerfile) build mode — no Effect
 * program is bundled; the in-VM server is plain Bun.
 *
 * The build role is created bare; the image grants it the trust + build
 * permissions it needs through a binding.
 */
export const ShellBuildRole = AWS.IAM.Role("ShellMicrovmBuildRole");

export class ShellMicrovm extends AWS.Lambda.MicrovmImage<ShellMicrovm>()(
  "ShellMicrovm",
) {}

export default ShellMicrovm.make(
  ShellBuildRole.pipe(
    Effect.map((buildRole) => ({
      context: fileURLToPath(new URL("../context/", import.meta.url)),
      buildRole,
      resources: [{ minimumMemoryInMiB: 512 }],
      cpuConfigurations: [{ architecture: "ARM_64" }],
    })),
  ),
  // External mode builds from the Dockerfile; there is no Effect runtime to
  // bundle into the image.
  Effect.succeed({}),
);
