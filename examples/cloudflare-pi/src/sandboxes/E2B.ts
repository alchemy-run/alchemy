import * as AIE2B from "@alchemy.run/ai/E2B";
import * as E2B from "@alchemy.run/e2b";

/**
 * E2B finds a sandbox by its metadata and pauses it on `suspend`, keeping
 * its memory and files. E2B kills a sandbox left running for ten minutes.
 */
export const E2BSandbox = AIE2B.Sandboxes(E2B.Template("E2BBase", { image: "node:22-bookworm" }));
