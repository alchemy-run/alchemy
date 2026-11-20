import * as AIDaytona from "@alchemy.run/ai/Daytona";
import * as Daytona from "@alchemy.run/daytona";

/**
 * Daytona finds a sandbox by its name and stops it on `suspend`, keeping
 * its disk. Daytona stops a sandbox idle for fifteen minutes and deletes
 * one that has been stopped for a day.
 */
export const DaytonaSandbox = AIDaytona.Sandboxes(
  Daytona.Snapshot("DaytonaBase", { image: "node:22-bookworm", cpu: 1, memory: 1, disk: 3 }),
);
