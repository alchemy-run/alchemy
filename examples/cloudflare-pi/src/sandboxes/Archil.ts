import * as AIArchil from "@alchemy.run/ai/Archil";
import * as Archil from "@alchemy.run/archil";

/**
 * Archil finds a sandbox by its name. `suspend` pauses a running sandbox,
 * keeping its memory and files; Archil also pauses one that is idle, and
 * resumes it on the next command.
 */
export const ArchilSandbox = AIArchil.Sandboxes(
  Archil.Image("ArchilBase", { image: "node:22-bookworm" }),
);
