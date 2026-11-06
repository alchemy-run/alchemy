// src/Images.ts
import * as Daytona from "@alchemy.run/daytona";

// The image every sandbox boots from, with its default size.
export const Base = Daytona.Snapshot("Base", {
  image: "node:22-bookworm-slim",
  cpu: 1,
  memory: 1,
  disk: 3,
});
