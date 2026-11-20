import * as AIBoat from "@alchemy.run/ai/Boat";
import * as Boat from "@alchemy.run/boat";

/**
 * Boat finds a sandbox by a label and stops it on `suspend`, keeping its
 * disk. Boat stops a sandbox left running for ten minutes.
 */
export const BoatSandbox = AIBoat.Sandboxes(
  Boat.Snapshot("BoatBase", { run: ["npm install --global pnpm"] }),
);
