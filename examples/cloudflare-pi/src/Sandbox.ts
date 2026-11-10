import * as E2B from "@alchemy.run/e2b";

/** Every conversation's sandbox boots from this image. */
export const Base = E2B.Template("Base", { image: "node:22-bookworm" });
